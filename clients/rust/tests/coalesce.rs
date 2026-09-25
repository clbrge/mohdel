use futures::StreamExt;
use mohdel_client::{coalesce, BufferOpts, EventStream};
use mohdel_protocol::{AnswerResult, DeltaChunk, DeltaKind, Event, Severity, Status, TypedError};

fn delta(text: &str, kind: DeltaKind) -> Event {
    Event::Delta {
        delta: DeltaChunk {
            r#type: kind,
            delta: text.into(),
        },
    }
}

fn msg(text: &str) -> Event {
    delta(text, DeltaKind::Message)
}

fn done() -> Event {
    Event::Done {
        result: AnswerResult {
            status: Status::Completed,
            ..Default::default()
        },
    }
}

fn stream(items: Vec<Result<Event, TypedError>>) -> EventStream {
    Box::pin(futures::stream::iter(items))
}

async fn run(items: Vec<Event>, opts: BufferOpts) -> Vec<String> {
    coalesce(stream(items.into_iter().map(Ok).collect()), opts)
        .map(|item| serde_json::to_string(&item.unwrap()).unwrap())
        .collect()
        .await
}

fn json(events: Vec<Event>) -> Vec<String> {
    events
        .iter()
        .map(|e| serde_json::to_string(e).unwrap())
        .collect()
}

const WIDE: BufferOpts = BufferOpts {
    max_chars: 1000,
    max_ms: 60_000,
};

#[tokio::test]
async fn merges_until_max_chars_and_flushes_before_the_terminal() {
    let opts = BufferOpts {
        max_chars: 10,
        ..WIDE
    };
    let out = run(vec![msg("hello"), msg("world!"), msg("tail"), done()], opts).await;
    assert_eq!(out, json(vec![msg("helloworld!"), msg("tail"), done()]));
}

#[tokio::test]
async fn max_ms_elapsed_flushes_on_arrival() {
    let opts = BufferOpts {
        max_chars: 1000,
        max_ms: 0,
    };
    let out = run(vec![msg("a"), msg("b"), done()], opts).await;
    assert_eq!(out, json(vec![msg("a"), msg("b"), done()]));
}

#[tokio::test]
async fn a_change_of_kind_flushes_the_previous_kind() {
    let out = run(
        vec![
            msg("Let me check. "),
            delta("{\"city\":", DeltaKind::FunctionCall),
            delta("\"Paris\"}", DeltaKind::FunctionCall),
            done(),
        ],
        WIDE,
    )
    .await;
    assert_eq!(
        out,
        json(vec![
            msg("Let me check. "),
            delta("{\"city\":\"Paris\"}", DeltaKind::FunctionCall),
            done(),
        ])
    );
}

#[tokio::test]
async fn other_items_pass_through_in_order() {
    let idle = Event::Idle { since_ms: 5000 };
    let out = run(vec![msg("a"), idle.clone(), msg("b"), done()], WIDE).await;
    assert_eq!(out, json(vec![msg("a"), idle, msg("b"), done()]));

    let error = TypedError {
        message: "socket".into(),
        detail: None,
        severity: Severity::Error,
        retryable: true,
        kind: Some("NET_ERROR".into()),
    };
    let items: Vec<_> = coalesce(stream(vec![Ok(msg("a")), Err(error)]), WIDE)
        .collect()
        .await;
    assert!(matches!(&items[0], Ok(Event::Delta { delta }) if delta.delta == "a"));
    assert!(matches!(&items[1], Err(e) if e.kind.as_deref() == Some("NET_ERROR")));
}

#[tokio::test]
async fn empty_deltas_dropped_and_an_unterminated_stream_still_flushes() {
    let out = run(vec![msg(""), msg("x")], WIDE).await;
    assert_eq!(out, json(vec![msg("x")]));
}

#[tokio::test]
async fn defaults_are_the_facades_and_count_utf16_units() {
    let d = BufferOpts::default();
    assert_eq!((d.max_chars, d.max_ms), (250, 10_000));

    let opts = BufferOpts {
        max_chars: 4,
        ..WIDE
    };
    // "😀" is two UTF-16 units, as JS `length` counts it.
    let out = run(vec![msg("😀"), msg("😀"), msg("z")], opts).await;
    assert_eq!(out, json(vec![msg("😀😀"), msg("z")]));
}
