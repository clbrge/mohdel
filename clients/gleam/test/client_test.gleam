import gleam/bit_array
import gleam/dict
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{Some}
import gleam/string
import gleeunit/should
import helpers
import mohdel.{Continue, Stop}
import mohdel/envelope
import mohdel/types.{Delta, Done}

fn envelope_json() -> json.Json {
  envelope.new(model: "local/llama3.1-8b", prompt: "why is the sky blue")
  |> envelope.call_id("c-1")
  |> envelope.auth_id("u-1")
  |> envelope.output_budget(4)
  |> envelope.to_json
}

fn client(bits: BitArray, size: Int) -> #(mohdel.Client, helpers.Ref) {
  let log = helpers.log_new()
  let client =
    mohdel.connect("/tmp/data.sock")
    |> mohdel.with_admin("/tmp/admin.sock")
    |> mohdel.with_transport(helpers.transport(bits, size, log))
  #(client, log)
}

pub fn call_streams_events_and_sends_the_envelope_test() {
  let #(client, log) = client(helpers.fixture("call-200-stream.raw"), 5)
  let events =
    should.be_ok(
      mohdel.fold(client, envelope_json(), [], fn(acc, event) {
        #([event, ..acc], Continue)
      }),
    )
  let assert [Done(result), _, _, _, Delta("message", "The")] = events
  result.output |> should.equal(Some("The sky is blue"))
  let assert [request] = helpers.log_all(log)
  let assert Ok(text) = bit_array.to_string(request)
  let assert Ok(#(_head, body)) = split_body(text)
  let assert Ok(sent) =
    json.parse(body, decode.dict(decode.string, decode.dynamic))
  let assert Ok(model) =
    decode.run(should.be_ok(dict.get(sent, "model")), decode.string)
  model |> should.equal("local/llama3.1-8b")
  should.be_true(string.starts_with(text, "POST /v1/call HTTP/1.1\r\n"))
}

fn split_body(text: String) -> Result(#(String, String), Nil) {
  string.split_once(text, "\r\n\r\n")
}

pub fn collect_returns_the_done_result_test() {
  let #(client, _) = client(helpers.fixture("call-200-stream.raw"), 64)
  let result = should.be_ok(mohdel.collect(client, envelope_json()))
  result.output_tokens |> should.equal(4)
  result.status |> should.equal("incomplete")
}

pub fn collect_raises_the_error_event_test() {
  let #(client, _) = client(helpers.fixture("call-200-error-event.raw"), 64)
  let error = should.be_error(mohdel.collect(client, envelope_json()))
  error.type_ |> should.equal(Some("SESSION_UNKNOWN_MODEL"))
}

pub fn non_200_is_the_gate_typed_error_test() {
  let #(client, _) =
    client(helpers.fixture("call-400-invalid-envelope.raw"), 64)
  let error = should.be_error(mohdel.collect(client, envelope_json()))
  error.type_ |> should.equal(Some("PROTOCOL_INVALID_ENVELOPE"))
  error.retryable |> should.be_false
}

pub fn non_json_non_200_is_protocol_http_error_test() {
  let bits =
    bit_array.from_string(
      "HTTP/1.1 503 Service Unavailable\r\ncontent-length: 4\r\n\r\nbusy",
    )
  let #(client, _) = client(bits, 64)
  let error = should.be_error(mohdel.collect(client, envelope_json()))
  error.type_ |> should.equal(Some("PROTOCOL_HTTP_ERROR"))
  error.retryable |> should.be_true
}

pub fn non_event_line_is_protocol_invalid_event_test() {
  let bits =
    bit_array.from_string(
      "HTTP/1.1 200 OK\r\ncontent-type: application/x-ndjson\r\n\r\n{\"hello\":\"world\"}\n",
    )
  let #(client, _) = client(bits, 64)
  let error = should.be_error(mohdel.collect(client, envelope_json()))
  error.type_ |> should.equal(Some("PROTOCOL_INVALID_EVENT"))
}

pub fn truncated_chunked_body_is_protocol_http_error_test() {
  let bits =
    bit_array.from_string(
      "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n10\r\n{\"type\":",
    )
  let #(client, _) = client(bits, 64)
  let error = should.be_error(mohdel.collect(client, envelope_json()))
  error.type_ |> should.equal(Some("PROTOCOL_HTTP_ERROR"))
}

pub fn stop_ends_the_stream_early_test() {
  let #(client, _) = client(helpers.fixture("call-200-stream.raw"), 64)
  let seen =
    should.be_ok(
      mohdel.fold(client, envelope_json(), 0, fn(n, _event) { #(n + 1, Stop) }),
    )
  seen |> should.equal(1)
}

pub fn empty_response_is_net_error_test() {
  let #(client, _) = client(<<>>, 64)
  let error = should.be_error(mohdel.collect(client, envelope_json()))
  error.type_ |> should.equal(Some("NET_ERROR"))
  error.retryable |> should.be_true
}

pub fn image_test() {
  let body =
    "{\"status\":\"completed\",\"images\":[{\"mimeType\":\"image/png\","
    <> "\"url\":\"https://cdn.example/abc.png\"}],\"seed\":42,"
    <> "\"timestamps\":{\"start\":\"1\",\"first\":\"3\",\"end\":\"3\"}}"
  let #(client, log) = client(helpers.json_response(body), 64)
  let result = should.be_ok(mohdel.image(client, json.object([])))
  let assert [image] = result.images
  image.url |> should.equal(Some("https://cdn.example/abc.png"))
  result.seed |> should.equal(Some(42))
  let assert [request] = helpers.log_all(log)
  let assert Ok(text) = bit_array.to_string(request)
  should.be_true(string.starts_with(text, "POST /v1/image HTTP/1.1\r\n"))
}

pub fn conformance_results_decode_test() {
  let images = helpers.conformance("images.json")
  use name <- list.each([
    "result-url-only",
    "result-base64-only",
    "result-multi-image",
  ])
  let result =
    should.be_ok(json.parse(
      images,
      decode.at([name], types.image_result_decoder()),
    ))
  result.status |> should.equal("completed")
  let transcriptions = helpers.conformance("transcriptions.json")
  use name <- list.each(["result-duration-billed", "result-token-billed"])
  let result =
    should.be_ok(json.parse(
      transcriptions,
      decode.at([name], types.transcription_result_decoder()),
    ))
  result.status |> should.equal("completed")
}

pub fn image_malformed_test() {
  let #(client, _) =
    client(helpers.json_response("{\"status\":\"completed\"}"), 64)
  let error = should.be_error(mohdel.image(client, json.object([])))
  error.type_ |> should.equal(Some("PROTOCOL_INVALID_EVENT"))
}

pub fn transcription_test() {
  let body =
    "{\"status\":\"completed\",\"text\":\"Bonjour tout le monde.\",\"language\":\"fr\","
    <> "\"durationSeconds\":12.5,\"cost\":0.0000834,"
    <> "\"timestamps\":{\"start\":\"1\",\"first\":\"3\",\"end\":\"3\"}}"
  let #(client, _) = client(helpers.json_response(body), 64)
  let result = should.be_ok(mohdel.transcription(client, json.object([])))
  result.text |> should.equal("Bonjour tout le monde.")
  result.duration_seconds |> should.equal(Some(12.5))
}

pub fn health_test() {
  let #(client, log) = client(helpers.fixture("health-200.raw"), 64)
  let health = should.be_ok(mohdel.health(client))
  health.status |> should.equal("ok")
  let assert [request] = helpers.log_all(log)
  let assert Ok(text) = bit_array.to_string(request)
  should.be_true(string.starts_with(text, "GET /v1/health HTTP/1.1\r\n"))
}

pub fn health_without_admin_socket_test() {
  let client = mohdel.connect("/tmp/data.sock")
  let error = should.be_error(mohdel.health(client))
  error.type_ |> should.equal(Some("CONFIGURATION_MISSING"))
}

pub fn envelope_to_json_test() {
  let text =
    envelope.new(model: "openai/gpt-5-mini", prompt: "hi")
    |> envelope.call_id("c")
    |> envelope.key("sk")
    |> envelope.output_budget(20)
    |> envelope.with("outputType", json.string("json"))
    |> envelope.to_json
    |> json.to_string
  text
  |> should.equal(
    "{\"callId\":\"c\",\"authId\":\"local\",\"auth\":{\"key\":\"sk\"},\"model\":\"openai/gpt-5-mini\","
    <> "\"prompt\":\"hi\",\"outputBudget\":20,\"outputType\":\"json\"}",
  )
}
