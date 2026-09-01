//! mohdel client for Rust: talks to a thin-gate over its unix socket.
//!
//! ```no_run
//! use futures::StreamExt;
//! use mohdel_client::Client;
//! use mohdel_protocol::{Auth, CallEnvelope, Event, Prompt, secret::SecretString};
//!
//! # async fn demo() -> Result<(), mohdel_protocol::TypedError> {
//! let client = Client::new("/tmp/mohdel-data.sock");
//! let envelope = CallEnvelope {
//!     call_id: "c-1".into(),
//!     auth_id: "u-1".into(),
//!     auth: Some(Auth { key: SecretString::new("sk-...") }),
//!     model: "anthropic/claude-haiku-4-5".into(),
//!     prompt: Prompt::Text("Hello".into()),
//!     ..Client::envelope_defaults()
//! };
//! let mut events = client.call(&envelope).await?;
//! while let Some(event) = events.next().await {
//!     if let Event::Delta { delta } = event? {
//!         print!("{}", delta.delta);
//!     }
//! }
//! # Ok(()) }
//! ```
//!
//! Dropping the stream before the terminal event closes the connection,
//! which is how a caller cancels an in-flight call.

pub mod wire;

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;
use futures::Stream;
use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

pub use mohdel_protocol as protocol;
use mohdel_protocol::{
    AnswerResult, CallEnvelope, Event, ImageEnvelope, ImageResult, Severity,
    TranscriptionEnvelope, TranscriptionResult, TypedError,
};

use wire::{Body, Framer, Head, WireError};

/// A byte reader for one response; dropping it closes the connection.
pub type Reader = Box<dyn AsyncRead + Send + Unpin>;

/// The events of one call. Dropping it before the terminal event closes
/// the connection, which is how a caller cancels.
pub type EventStream = Pin<Box<dyn Stream<Item = Result<Event, TypedError>> + Send>>;

/// Opens a connection to the socket path and sends the request bytes.
/// The default is a unix socket; tests substitute a replay.
#[async_trait]
pub trait Transport: Send + Sync {
    async fn open(&self, socket: &Path, request: Vec<u8>) -> std::io::Result<Reader>;
}

pub struct UnixTransport;

#[async_trait]
impl Transport for UnixTransport {
    async fn open(&self, socket: &Path, request: Vec<u8>) -> std::io::Result<Reader> {
        let mut stream = UnixStream::connect(socket).await?;
        stream.write_all(&request).await?;
        Ok(Box::new(stream))
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Health {
    pub status: String,
    pub version: String,
    pub uptime_ms: u64,
}

#[derive(Clone)]
pub struct Client {
    socket: PathBuf,
    admin_socket: Option<PathBuf>,
    transport: Arc<dyn Transport>,
}

impl Client {
    pub fn new(socket: impl Into<PathBuf>) -> Client {
        Client { socket: socket.into(), admin_socket: None, transport: Arc::new(UnixTransport) }
    }

    pub fn with_admin(mut self, admin_socket: impl Into<PathBuf>) -> Client {
        self.admin_socket = Some(admin_socket.into());
        self
    }

    pub fn with_transport(mut self, transport: Arc<dyn Transport>) -> Client {
        self.transport = transport;
        self
    }

    /// A `CallEnvelope` with every optional field unset, for
    /// struct-update syntax.
    pub fn envelope_defaults() -> CallEnvelope {
        CallEnvelope {
            call_id: String::new(),
            auth_id: "local".into(),
            auth: None,
            traceparent: None,
            baggage: None,
            model: String::new(),
            prompt: mohdel_protocol::Prompt::Text(String::new()),
            output_budget: None,
            output_type: None,
            output_style: None,
            output_effort: None,
            speed: None,
            images: None,
            videos: None,
            cache: None,
            tools: None,
            tool_choice: None,
            parallel_tool_calls: None,
            identifier: None,
            idle_heartbeat_ms: None,
            provider_options: None,
        }
    }

    /// Streams the events of one call. The last item is the `done` or
    /// `error` event; dropping the stream earlier cancels the call.
    pub async fn call(&self, envelope: &CallEnvelope) -> Result<EventStream, TypedError> {
        let body = serde_json::to_vec(envelope).map_err(|e| {
            typed("PROTOCOL_INVALID_ENVELOPE", "envelope does not serialize", Some(e.to_string()), false)
        })?;
        let (reader, head, rest) = self.open(&self.socket, "POST", wire::CALL_PATH, Some(&body)).await?;
        if head.status != 200 {
            let bytes = read_all(reader, &head, rest).await?;
            return Err(rejection(head.status, &bytes));
        }
        let state = StreamState {
            reader: Some(reader),
            body: Body::from_head(&head),
            framer: Framer::new(),
            pending: rest,
            queue: std::collections::VecDeque::new(),
            finished: false,
        };
        Ok(Box::pin(futures::stream::unfold(state, |mut state| async move {
            state.next().await.map(|item| (item, state))
        })))
    }

    /// Drains one call: the `done` result, or the `error` event as the error.
    pub async fn collect(&self, envelope: &CallEnvelope) -> Result<AnswerResult, TypedError> {
        use futures::StreamExt;
        let mut events = self.call(envelope).await?;
        while let Some(event) = events.next().await {
            match event? {
                Event::Done { result } => return Ok(result),
                Event::Error { error } => return Err(error),
                _ => {}
            }
        }
        Err(typed("PROTOCOL_INVALID_EVENT", "stream ended without a terminal event", None, false))
    }

    pub async fn image(&self, envelope: &ImageEnvelope) -> Result<ImageResult, TypedError> {
        let body = serde_json::to_vec(envelope).map_err(|e| {
            typed("PROTOCOL_INVALID_ENVELOPE", "envelope does not serialize", Some(e.to_string()), false)
        })?;
        self.fetch_json(&self.socket, "POST", wire::IMAGE_PATH, Some(&body), "thin-gate returned a malformed ImageResult")
            .await
    }

    pub async fn transcription(
        &self,
        envelope: &TranscriptionEnvelope,
    ) -> Result<TranscriptionResult, TypedError> {
        let body = serde_json::to_vec(envelope).map_err(|e| {
            typed("PROTOCOL_INVALID_ENVELOPE", "envelope does not serialize", Some(e.to_string()), false)
        })?;
        self.fetch_json(
            &self.socket,
            "POST",
            wire::TRANSCRIPTION_PATH,
            Some(&body),
            "thin-gate returned a malformed TranscriptionResult",
        )
        .await
    }

    pub async fn health(&self) -> Result<Health, TypedError> {
        let Some(admin) = self.admin_socket.clone() else {
            return Err(typed(
                "CONFIGURATION_MISSING",
                "health() needs the admin socket: use with_admin",
                None,
                false,
            ));
        };
        self.fetch_json(&admin, "GET", wire::HEALTH_PATH, None, "thin-gate returned a malformed health response")
            .await
    }

    async fn open(
        &self,
        socket: &Path,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
    ) -> Result<(Reader, Head, Vec<u8>), TypedError> {
        let mut reader = self
            .transport
            .open(socket, wire::request(method, path, body))
            .await
            .map_err(|e| net_error(e.to_string()))?;
        let mut buf = Vec::new();
        loop {
            match wire::parse_head(&buf).map_err(from_wire)? {
                Some((head, consumed)) => {
                    let rest = buf.split_off(consumed);
                    return Ok((reader, head, rest));
                }
                None => {
                    let mut chunk = [0u8; 8192];
                    let n = reader.read(&mut chunk).await.map_err(|e| net_error(e.to_string()))?;
                    if n == 0 {
                        return Err(if buf.is_empty() {
                            from_wire(WireError::NoResponse)
                        } else {
                            from_wire(WireError::Malformed("connection closed inside the response head".into()))
                        });
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
            }
        }
    }

    async fn fetch_json<T: serde::de::DeserializeOwned>(
        &self,
        socket: &Path,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        malformed: &str,
    ) -> Result<T, TypedError> {
        let (reader, head, rest) = self.open(socket, method, path, body).await?;
        let bytes = read_all(reader, &head, rest).await?;
        if head.status != 200 {
            return Err(rejection(head.status, &bytes));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| typed("PROTOCOL_INVALID_EVENT", malformed, None, false))
    }
}

struct StreamState {
    reader: Option<Reader>,
    body: Body,
    framer: Framer,
    pending: Vec<u8>,
    queue: std::collections::VecDeque<Result<Event, TypedError>>,
    finished: bool,
}

impl StreamState {
    fn close(&mut self) {
        self.reader = None;
        self.finished = true;
    }

    fn fail(&mut self, error: TypedError) -> Option<Result<Event, TypedError>> {
        self.close();
        Some(Err(error))
    }

    fn push_lines(&mut self, lines: Vec<String>) {
        for line in lines {
            match serde_json::from_str::<Event>(&line) {
                Ok(event) => self.queue.push_back(Ok(event)),
                Err(_) => {
                    let preview: String = line.chars().take(200).collect();
                    self.queue.push_back(Err(typed(
                        "PROTOCOL_INVALID_EVENT",
                        "received a non-Event line from thin-gate",
                        Some(preview),
                        false,
                    )));
                }
            }
        }
    }

    async fn next(&mut self) -> Option<Result<Event, TypedError>> {
        loop {
            if let Some(item) = self.queue.pop_front() {
                match &item {
                    Ok(Event::Done { .. }) | Ok(Event::Error { .. }) | Err(_) => self.close(),
                    _ => {}
                }
                return Some(item);
            }
            if self.finished {
                return None;
            }
            let bytes = std::mem::take(&mut self.pending);
            let bytes = if bytes.is_empty() {
                let reader = self.reader.as_mut()?;
                let mut chunk = [0u8; 8192];
                match reader.read(&mut chunk).await {
                    Ok(0) => {
                        if !self.body.may_end_with_close() {
                            return self.fail(from_wire(WireError::Malformed(
                                "connection closed inside the body".into(),
                            )));
                        }
                        return self.finish();
                    }
                    Ok(n) => chunk[..n].to_vec(),
                    Err(e) => return self.fail(net_error(e.to_string())),
                }
            } else {
                bytes
            };
            let mut data = Vec::new();
            let done = match self.body.feed(&bytes, &mut data) {
                Ok(done) => done,
                Err(e) => return self.fail(from_wire(e)),
            };
            match self.framer.feed(&data) {
                Ok(lines) => self.push_lines(lines),
                Err(e) => return self.fail(from_wire(e)),
            }
            if done && self.queue.is_empty() {
                return self.finish();
            }
            if done {
                self.reader = None;
                self.finished = true;
            }
        }
    }

    fn finish(&mut self) -> Option<Result<Event, TypedError>> {
        let tail = self.framer.finish();
        self.close();
        match tail {
            Err(e) => Some(Err(from_wire(e))),
            Ok(None) => None,
            Ok(Some(line)) => {
                self.push_lines(vec![line]);
                self.queue.pop_front()
            }
        }
    }
}

async fn read_all(mut reader: Reader, head: &Head, rest: Vec<u8>) -> Result<Vec<u8>, TypedError> {
    let mut body = Body::from_head(head);
    let mut out = Vec::new();
    let mut done = body.feed(&rest, &mut out).map_err(from_wire)?;
    let mut chunk = [0u8; 8192];
    while !done {
        let n = reader.read(&mut chunk).await.map_err(|e| net_error(e.to_string()))?;
        if n == 0 {
            if body.may_end_with_close() {
                break;
            }
            return Err(from_wire(WireError::Malformed("connection closed inside the body".into())));
        }
        done = body.feed(&chunk[..n], &mut out).map_err(from_wire)?;
    }
    Ok(out)
}

fn rejection(status: u16, body: &[u8]) -> TypedError {
    match serde_json::from_slice::<TypedError>(body) {
        Ok(error) if error.kind.is_some() => error,
        _ => typed(
            "PROTOCOL_HTTP_ERROR",
            &format!("thin-gate returned HTTP {status}"),
            None,
            status >= 500,
        ),
    }
}

fn typed(kind: &str, message: &str, detail: Option<String>, retryable: bool) -> TypedError {
    TypedError {
        message: message.to_string(),
        detail,
        severity: Severity::Error,
        retryable,
        kind: Some(kind.to_string()),
    }
}

fn net_error(detail: String) -> TypedError {
    typed("NET_ERROR", "thin-gate socket error", Some(detail), true)
}

fn from_wire(error: WireError) -> TypedError {
    match error {
        WireError::NoResponse => typed("NET_ERROR", "no response from thin-gate", None, true),
        WireError::Malformed(detail) => {
            typed("PROTOCOL_HTTP_ERROR", "malformed response from thin-gate", Some(detail), false)
        }
        WireError::LineTooLong => typed(
            "PROTOCOL_INVALID_EVENT",
            &format!("NDJSON line exceeds {} bytes without newline", wire::MAX_LINE_BYTES),
            None,
            false,
        ),
    }
}
