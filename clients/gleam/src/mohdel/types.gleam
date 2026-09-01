//// Wire types of the thin-gate surface and their decoders. Names follow
//// PROTOCOL.md: camelCase on the wire, snake_case here.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode.{type Decoder}
import gleam/int
import gleam/option.{type Option, None}

pub type TypedError {
  TypedError(
    type_: Option(String),
    message: String,
    detail: Option(String),
    severity: String,
    retryable: Bool,
  )
}

pub type Timestamps {
  Timestamps(start: String, first: String, end: String)
}

pub type ToolCall {
  ToolCall(
    id: String,
    name: String,
    arguments: Dynamic,
    thought_signature: Option(String),
  )
}

pub type AnswerResult {
  AnswerResult(
    status: String,
    output: Option(String),
    input_tokens: Int,
    output_tokens: Int,
    thinking_tokens: Int,
    cache_write_input_tokens: Option(Int),
    cache_write_1h_input_tokens: Option(Int),
    cache_read_input_tokens: Option(Int),
    cost: Float,
    timestamps: Timestamps,
    warning: Option(String),
    tool_calls: List(ToolCall),
    max_inter_frame_ms: Option(Int),
    reasoning: Option(String),
    speed: Option(String),
    served_speed: Option(String),
  )
}

pub type Event {
  /// A streamed chunk; `kind` is `"message"` or `"function_call"`.
  Delta(kind: String, delta: String)
  Idle(since_ms: Int)
  Done(result: AnswerResult)
  Failed(error: TypedError)
}

pub type ImageData {
  ImageData(mime_type: String, url: Option(String), base64: Option(String))
}

pub type ImageResult {
  ImageResult(
    status: String,
    images: List(ImageData),
    seed: Option(Int),
    timestamps: Timestamps,
  )
}

pub type TranscriptionResult {
  TranscriptionResult(
    status: String,
    text: String,
    language: Option(String),
    duration_seconds: Option(Float),
    input_tokens: Option(Int),
    output_tokens: Option(Int),
    cost: Float,
    timestamps: Timestamps,
  )
}

pub type Health {
  Health(status: String, version: String, uptime_ms: Int)
}

/// JSON numbers arrive as Erlang ints or floats; cost is either.
pub fn number() -> Decoder(Float) {
  decode.one_of(decode.float, or: [decode.int |> decode.map(int.to_float)])
}

fn optional_string(
  name: String,
  next: fn(Option(String)) -> Decoder(t),
) -> Decoder(t) {
  decode.optional_field(name, None, decode.optional(decode.string), next)
}

fn optional_int(
  name: String,
  next: fn(Option(Int)) -> Decoder(t),
) -> Decoder(t) {
  decode.optional_field(name, None, decode.optional(decode.int), next)
}

pub fn typed_error_decoder() -> Decoder(TypedError) {
  use type_ <- optional_string("type")
  use message <- decode.field("message", decode.string)
  use detail <- optional_string("detail")
  use severity <- decode.optional_field("severity", "error", decode.string)
  use retryable <- decode.optional_field("retryable", False, decode.bool)
  decode.success(TypedError(
    type_: type_,
    message: message,
    detail: detail,
    severity: severity,
    retryable: retryable,
  ))
}

pub fn timestamps_decoder() -> Decoder(Timestamps) {
  use start <- decode.field("start", decode.string)
  use first <- decode.field("first", decode.string)
  use end <- decode.field("end", decode.string)
  decode.success(Timestamps(start: start, first: first, end: end))
}

pub fn tool_call_decoder() -> Decoder(ToolCall) {
  use id <- decode.field("id", decode.string)
  use name <- decode.field("name", decode.string)
  use arguments <- decode.field("arguments", decode.dynamic)
  use thought_signature <- optional_string("thoughtSignature")
  decode.success(ToolCall(
    id: id,
    name: name,
    arguments: arguments,
    thought_signature: thought_signature,
  ))
}

pub fn answer_result_decoder() -> Decoder(AnswerResult) {
  use status <- decode.field("status", decode.string)
  use output <- optional_string("output")
  use input_tokens <- decode.field("inputTokens", decode.int)
  use output_tokens <- decode.field("outputTokens", decode.int)
  use thinking_tokens <- decode.optional_field("thinkingTokens", 0, decode.int)
  use cache_write_input_tokens <- optional_int("cacheWriteInputTokens")
  use cache_write_1h_input_tokens <- optional_int("cacheWrite1hInputTokens")
  use cache_read_input_tokens <- optional_int("cacheReadInputTokens")
  use cost <- decode.field("cost", number())
  use timestamps <- decode.field("timestamps", timestamps_decoder())
  use warning <- optional_string("warning")
  use tool_calls <- decode.optional_field(
    "toolCalls",
    [],
    decode.list(tool_call_decoder()),
  )
  use max_inter_frame_ms <- optional_int("maxInterFrameMs")
  use reasoning <- optional_string("reasoning")
  use speed <- optional_string("speed")
  use served_speed <- optional_string("servedSpeed")
  decode.success(AnswerResult(
    status: status,
    output: output,
    input_tokens: input_tokens,
    output_tokens: output_tokens,
    thinking_tokens: thinking_tokens,
    cache_write_input_tokens: cache_write_input_tokens,
    cache_write_1h_input_tokens: cache_write_1h_input_tokens,
    cache_read_input_tokens: cache_read_input_tokens,
    cost: cost,
    timestamps: timestamps,
    warning: warning,
    tool_calls: tool_calls,
    max_inter_frame_ms: max_inter_frame_ms,
    reasoning: reasoning,
    speed: speed,
    served_speed: served_speed,
  ))
}

pub fn event_decoder() -> Decoder(Event) {
  use type_ <- decode.field("type", decode.string)
  case type_ {
    "delta" -> {
      use kind <- decode.subfield(["delta", "type"], decode.string)
      use delta <- decode.subfield(["delta", "delta"], decode.string)
      decode.success(Delta(kind: kind, delta: delta))
    }
    "idle" -> {
      use since_ms <- decode.field("sinceMs", decode.int)
      decode.success(Idle(since_ms: since_ms))
    }
    "done" -> {
      use result <- decode.field("result", answer_result_decoder())
      decode.success(Done(result: result))
    }
    "error" -> {
      use error <- decode.field("error", typed_error_decoder())
      decode.success(Failed(error: error))
    }
    _ -> decode.failure(Idle(0), "Event")
  }
}

pub fn image_result_decoder() -> Decoder(ImageResult) {
  use status <- decode.field("status", decode.string)
  use images <- decode.field("images", decode.list(image_data_decoder()))
  use seed <- optional_int("seed")
  use timestamps <- decode.field("timestamps", timestamps_decoder())
  decode.success(ImageResult(
    status: status,
    images: images,
    seed: seed,
    timestamps: timestamps,
  ))
}

fn image_data_decoder() -> Decoder(ImageData) {
  use mime_type <- decode.field("mimeType", decode.string)
  use url <- optional_string("url")
  use base64 <- optional_string("base64")
  decode.success(ImageData(mime_type: mime_type, url: url, base64: base64))
}

pub fn transcription_result_decoder() -> Decoder(TranscriptionResult) {
  use status <- decode.field("status", decode.string)
  use text <- decode.field("text", decode.string)
  use language <- optional_string("language")
  use duration_seconds <- decode.optional_field(
    "durationSeconds",
    None,
    decode.optional(number()),
  )
  use input_tokens <- optional_int("inputTokens")
  use output_tokens <- optional_int("outputTokens")
  use cost <- decode.optional_field("cost", 0.0, number())
  use timestamps <- decode.field("timestamps", timestamps_decoder())
  decode.success(TranscriptionResult(
    status: status,
    text: text,
    language: language,
    duration_seconds: duration_seconds,
    input_tokens: input_tokens,
    output_tokens: output_tokens,
    cost: cost,
    timestamps: timestamps,
  ))
}

pub fn health_decoder() -> Decoder(Health) {
  use status <- decode.field("status", decode.string)
  use version <- decode.field("version", decode.string)
  use uptime_ms <- decode.field("uptime_ms", decode.int)
  decode.success(Health(status: status, version: version, uptime_ms: uptime_ms))
}
