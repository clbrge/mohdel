//! Runs only against a live thin-gate: set MOHDEL_GATE_SOCKET (and
//! MOHDEL_GATE_ADMIN_SOCKET for health). MOHDEL_LIVE_MODEL picks the
//! catalog key (default local/llama3.1-8b); MOHDEL_LIVE_KEY the auth key.

use futures::StreamExt;
use mohdel_client::Client;
use mohdel_protocol::secret::SecretString;
use mohdel_protocol::{Auth, CallEnvelope, Event, Prompt, Status};

fn live() -> Option<(Client, String)> {
    let socket = std::env::var("MOHDEL_GATE_SOCKET").ok()?;
    let mut client = Client::new(socket);
    if let Ok(admin) = std::env::var("MOHDEL_GATE_ADMIN_SOCKET") {
        client = client.with_admin(admin);
    }
    let model = std::env::var("MOHDEL_LIVE_MODEL").unwrap_or_else(|_| "local/llama3.1-8b".into());
    Some((client, model))
}

fn envelope(model: &str, prompt: &str, budget: u32) -> CallEnvelope {
    CallEnvelope {
        call_id: format!("rust-{}", std::process::id()),
        auth_id: "rust-live".into(),
        auth: Some(Auth { key: SecretString::new(std::env::var("MOHDEL_LIVE_KEY").unwrap_or_default()) }),
        model: model.into(),
        prompt: Prompt::Text(prompt.into()),
        output_budget: Some(budget),
        ..Client::envelope_defaults()
    }
}

#[tokio::test]
async fn live_stream() {
    let Some((client, model)) = live() else { return };
    let mut deltas = 0;
    let mut result = None;
    let mut events = client.call(&envelope(&model, "Say the single word \"hi\".", 20)).await.unwrap();
    while let Some(event) = events.next().await {
        match event.unwrap() {
            Event::Delta { .. } => deltas += 1,
            Event::Done { result: r } => result = Some(r),
            Event::Error { error } => panic!("error event: {error}"),
            Event::Idle { .. } => {}
        }
    }
    assert!(deltas > 0);
    let result = result.unwrap();
    assert_eq!(result.status, Status::Completed);
    assert!(result.input_tokens > 0 && result.output_tokens > 0);
}

#[tokio::test]
async fn live_budget_incomplete() {
    let Some((client, model)) = live() else { return };
    let result = client.collect(&envelope(&model, "Write a detailed essay about tigers.", 1)).await.unwrap();
    assert_eq!(result.status, Status::Incomplete);
    assert_eq!(result.warning.as_deref(), Some("insufficientOutputBudget"));
}

#[tokio::test]
async fn live_drop_cancels_then_next_call_works() {
    let Some((client, model)) = live() else { return };
    let mut events = client
        .call(&envelope(&model, "Count slowly from 1 to 100, one number per line.", 200))
        .await
        .unwrap();
    assert!(events.next().await.is_some());
    drop(events);
    let result = client.collect(&envelope(&model, "Say the single word \"hi\".", 20)).await.unwrap();
    assert_eq!(result.status, Status::Completed);
}

#[tokio::test]
async fn live_health() {
    let Some((client, _)) = live() else { return };
    if std::env::var("MOHDEL_GATE_ADMIN_SOCKET").is_err() {
        return;
    }
    assert_eq!(client.health().await.unwrap().status, "ok");
}
