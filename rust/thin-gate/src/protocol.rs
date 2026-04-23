//! Wire protocol types for thin-gate.
//!
//! JS mirror: `mohdel/js/core/{envelope,events,status,errors}.js`.
//! Shape is the flat `answer(prompt, options)` surface + result,
//! plus minimum transport metadata. camelCase on the wire.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::secret::SecretString;

// ---------- CallEnvelope (flat answer() options) ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallEnvelope {
    // Transport metadata
    pub call_id: String,
    pub auth_id: String,
    /// Inline API key. Optional — when omitted, the configured
    /// `AuthPolicy` (see `hooks::auth`) resolves one before the
    /// envelope is forwarded to the session subprocess. Defaulting
    /// to an error-returning policy preserves the legacy contract
    /// where this field was mandatory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<Auth>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traceparent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baggage: Option<String>,

    // Routing.
    // Wire contract: callers send only `model` as the full mohdel id
    // `"<provider>/<bare>[:<effort>]"` — same shape as `mo model list`
    // and cs-core. `provider` is a server-internal cache populated by
    // `normalize_routing` after the envelope is deserialized; never
    // read from the wire (callers passing it get rejected via
    // `deny_unknown_fields`). Only serialized when non-empty so the
    // post-normalization envelope reaches the session subprocess with
    // the split shape the JS session runtime expects, while pre-
    // normalization / round-trip fixtures stay clean.
    #[serde(skip_deserializing, default, skip_serializing_if = "String::is_empty")]
    pub provider: String,
    pub model: String,

    // answer() first arg
    pub prompt: Prompt,

    // answer options (flat)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_budget: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_type: Option<OutputType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_style: Option<OutputStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_effort: Option<String>, // per-model; validated at runtime
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<MediaRef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub videos: Option<Vec<MediaRef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolSpec>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<ToolChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parallel_tool_calls: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,

    /// Namespaced bag of provider-specific options. Keys are
    /// provider names (e.g. `"openrouter"`); values are opaque JSON
    /// the matching session adapter reads. Accepting `Value` here
    /// keeps the envelope schema from growing per-provider; adapters
    /// enforce the shape they expect for their own namespace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<HashMap<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Prompt {
    Text(String),
    Messages(Vec<Message>),
}

/// Split a mohdel model id `"<provider>/<bare>[:<effort>]"` into its
/// provider and `<bare>[:<effort>]` parts. Returns `None` if there's
/// no `/` (malformed id — callers should error out).
pub fn split_model_id(model: &str) -> Option<(&str, &str)> {
    model.split_once('/')
}

/// Split `model`'s provider prefix into `provider`, leaving `model`
/// as the bare id. Called once per envelope right after deserialize.
/// Downstream code (cooldown keys, session dispatch, JS adapters)
/// reads both fields in their split form.
pub fn normalize_routing(provider: &mut String, model: &mut String) -> Result<(), String> {
    match split_model_id(model) {
        Some((p, rest)) => {
            *provider = p.to_string();
            *model = rest.to_string();
            Ok(())
        }
        None => Err(format!(
            "model must be '<provider>/<id>' (got: {model})"
        )),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputType {
    Text,
    Json,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputStyle {
    Chat,
    Coding,
    Analysis,
    Translation,
    Creative,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolChoice {
    Mode(ToolChoiceMode),
    Named(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolChoiceMode {
    Auto,
    Required,
    None,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Auth {
    pub key: SecretString,
    /// Optional override of the adapter's default provider endpoint.
    /// Lets operators point mohdel at a self-hosted deployment,
    /// regional endpoint, proxy, or test server without patching
    /// adapters. Adapters treat it as `baseURL ?? ADAPTER_DEFAULT`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

impl std::fmt::Debug for Auth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Auth")
            .field("key", &"<redacted>")
            .field("base_url", &self.base_url)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolSpec {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Message {
    pub role: Role,
    pub content: MessageContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Name of the tool that produced this message's content. Set on
    /// `role = 'tool'` only. Paired with `toolCallId` for symmetry —
    /// at the `Message` level, a bare `name` would be ambiguous (author?
    /// speaker?). Inside `ToolCall` we keep just `name` because the
    /// surrounding struct makes the meaning clear.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Set on `assistant` role messages when the model invoked tools
    /// in that turn. Adapters translate to the provider-native
    /// tool_use / function_call representation downstream.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<MessagePart>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum MessagePart {
    Text { text: String },
    Reasoning { text: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaRef {
    pub file_uri: String,
    pub mime_type: String,
}

// ---------- Events (3 variants) ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Event {
    Delta { delta: DeltaChunk },
    Done { result: AnswerResult },
    Error { error: TypedError },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeltaChunk {
    pub r#type: DeltaKind,
    pub delta: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeltaKind {
    Message,
    FunctionCall,
}

// ---------- AnswerResult (terminal `done.result`) ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnswerResult {
    pub status: Status,
    pub output: Option<String>,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub thinking_tokens: u32,
    /// Single number (USD). No per-token breakdown on the wire.
    pub cost: f64,
    pub timestamps: Timestamps,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_inter_frame_ms: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Timestamps {
    pub start: String,
    pub first: String,
    pub end: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Parsed object. Not a JSON string.
    pub arguments: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Completed,
    ToolUse,
    Incomplete,
}

// ---------- TypedError ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypedError {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub severity: Severity,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "type")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

// ---------- ImageEnvelope / ImageResult (one-shot, non-streaming) ----------
//
// Mirrors `js/core/image.js`. Separate call path from CallEnvelope:
// image generation is a single request/response — no streaming —
// hence a distinct HTTP route (`POST /v1/image`) and a plain JSON
// response body (not NDJSON).
//
// `op: "image"` is the driver-stdin protocol tag (internal),
// unused over HTTP.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageEnvelope {
    pub call_id: String,
    pub auth_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<Auth>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traceparent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baggage: Option<String>,

    // See CallEnvelope — same rules.
    #[serde(skip_deserializing, default, skip_serializing_if = "String::is_empty")]
    pub provider: String,
    pub model: String,
    pub prompt: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageData {
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageResult {
    /// Always "completed" — images are one-shot, no incomplete state.
    pub status: ImageStatus,
    pub images: Vec<ImageData>,
    /// Echo of provider seed when available; null otherwise.
    pub seed: Option<u64>,
    /// `first` == `end` for images (no streaming); JS side keeps the
    /// field present for shape parity with AnswerResult timestamps.
    pub timestamps: Timestamps,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageStatus {
    Completed,
}
