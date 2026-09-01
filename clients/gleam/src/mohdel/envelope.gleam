//// Builder for a `CallEnvelope` (PROTOCOL.md §3.1). The common fields
//// are typed; anything else goes in through `with`.

import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}

pub type Envelope {
  Envelope(
    call_id: String,
    auth_id: String,
    key: String,
    model: String,
    prompt: Json,
    output_budget: Option(Int),
    output_effort: Option(String),
    identifier: Option(String),
    extra: List(#(String, Json)),
  )
}

@external(erlang, "mohdel_ffi", "call_id")
fn fresh_call_id() -> String

pub fn new(model model: String, prompt prompt: String) -> Envelope {
  Envelope(
    call_id: fresh_call_id(),
    auth_id: "local",
    key: "",
    model: model,
    prompt: json.string(prompt),
    output_budget: None,
    output_effort: None,
    identifier: None,
    extra: [],
  )
}

pub fn key(envelope: Envelope, key: String) -> Envelope {
  Envelope(..envelope, key: key)
}

pub fn auth_id(envelope: Envelope, auth_id: String) -> Envelope {
  Envelope(..envelope, auth_id: auth_id)
}

pub fn call_id(envelope: Envelope, call_id: String) -> Envelope {
  Envelope(..envelope, call_id: call_id)
}

/// A structured prompt (`Message[]`), built with `gleam/json`.
pub fn prompt_json(envelope: Envelope, prompt: Json) -> Envelope {
  Envelope(..envelope, prompt: prompt)
}

pub fn output_budget(envelope: Envelope, tokens: Int) -> Envelope {
  Envelope(..envelope, output_budget: Some(tokens))
}

pub fn output_effort(envelope: Envelope, effort: String) -> Envelope {
  Envelope(..envelope, output_effort: Some(effort))
}

pub fn identifier(envelope: Envelope, identifier: String) -> Envelope {
  Envelope(..envelope, identifier: Some(identifier))
}

/// Any other envelope field (`tools`, `images`, `outputType`, ...).
pub fn with(envelope: Envelope, field: String, value: Json) -> Envelope {
  Envelope(..envelope, extra: list.append(envelope.extra, [#(field, value)]))
}

pub fn to_json(envelope: Envelope) -> Json {
  json.object(
    list.flatten([
      [
        #("callId", json.string(envelope.call_id)),
        #("authId", json.string(envelope.auth_id)),
        #("auth", json.object([#("key", json.string(envelope.key))])),
        #("model", json.string(envelope.model)),
        #("prompt", envelope.prompt),
      ],
      optional("outputBudget", envelope.output_budget, json.int),
      optional("outputEffort", envelope.output_effort, json.string),
      optional("identifier", envelope.identifier, json.string),
      envelope.extra,
    ]),
  )
}

fn optional(
  name: String,
  value: Option(a),
  to_json: fn(a) -> Json,
) -> List(#(String, Json)) {
  case value {
    Some(v) -> [#(name, to_json(v))]
    None -> []
  }
}
