//! Coalesce the delta events of a `call()` stream, with the facade's
//! `bufferOpts` rules (`createRealtimeDeltaBuffer`): deltas of one kind
//! accumulate until `max_chars` is reached or `max_ms` has passed since
//! the last flush, checked as each delta arrives — there is no timer. A
//! change of kind, any other item, and the end of the stream flush first,
//! so order is kept and the terminal event is never held back.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use futures::StreamExt;
use mohdel_protocol::{DeltaChunk, DeltaKind, Event, TypedError};

use crate::EventStream;

#[derive(Debug, Clone, Copy)]
pub struct BufferOpts {
    /// Counted in UTF-16 code units, as the JS paths count `length`.
    pub max_chars: usize,
    pub max_ms: u64,
}

impl Default for BufferOpts {
    fn default() -> Self {
        BufferOpts {
            max_chars: 250,
            max_ms: 10_000,
        }
    }
}

/// Wraps a call's events; dropping the result drops the call's stream,
/// so cancelling works as before.
pub fn coalesce(events: EventStream, opts: BufferOpts) -> EventStream {
    let state = Coalescer {
        inner: events,
        opts,
        buffer: String::new(),
        units: 0,
        kind: DeltaKind::Message,
        last_flush: Instant::now(),
        out: VecDeque::new(),
        ended: false,
    };
    Box::pin(futures::stream::unfold(state, |mut state| async move {
        state.next().await.map(|item| (item, state))
    }))
}

struct Coalescer {
    inner: EventStream,
    opts: BufferOpts,
    buffer: String,
    units: usize,
    kind: DeltaKind,
    last_flush: Instant,
    out: VecDeque<Result<Event, TypedError>>,
    ended: bool,
}

impl Coalescer {
    async fn next(&mut self) -> Option<Result<Event, TypedError>> {
        loop {
            if let Some(item) = self.out.pop_front() {
                return Some(item);
            }
            if self.ended {
                return None;
            }
            match self.inner.next().await {
                Some(Ok(Event::Delta { delta })) => {
                    if delta.delta.is_empty() {
                        continue;
                    }
                    if !self.buffer.is_empty() && delta.r#type != self.kind {
                        self.flush();
                    }
                    self.kind = delta.r#type;
                    self.units += delta.delta.encode_utf16().count();
                    self.buffer.push_str(&delta.delta);
                    if self.units >= self.opts.max_chars
                        || self.last_flush.elapsed() >= Duration::from_millis(self.opts.max_ms)
                    {
                        self.flush();
                    }
                }
                Some(other) => {
                    if !self.buffer.is_empty() {
                        self.flush();
                    }
                    self.out.push_back(other);
                }
                None => {
                    self.ended = true;
                    if !self.buffer.is_empty() {
                        self.flush();
                    }
                }
            }
        }
    }

    fn flush(&mut self) {
        let delta = DeltaChunk {
            r#type: self.kind,
            delta: std::mem::take(&mut self.buffer),
        };
        self.units = 0;
        self.last_flush = Instant::now();
        self.out.push_back(Ok(Event::Delta { delta }));
    }
}
