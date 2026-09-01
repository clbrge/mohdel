import gleam/bit_array
import gleam/dict
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleeunit/should
import helpers
import mohdel/protocol
import mohdel/types.{Delta, Done, Failed}

pub fn request_bytes_test() {
  protocol.request("POST", "/v1/call", Some("{\"a\":1}"))
  |> bit_array.to_string
  |> should.equal(Ok(
    "POST /v1/call HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n"
    <> "Content-Type: application/json\r\nContent-Length: 7\r\n\r\n{\"a\":1}",
  ))
  protocol.request("GET", "/v1/health", None)
  |> bit_array.to_string
  |> should.equal(Ok(
    "GET /v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
  ))
}

/// Drives head + body + framer over `size`-byte slices, like a client does.
fn run(bits: BitArray, size: Int) -> #(protocol.Head, List(String)) {
  let slices = helpers.slices(bits, size)
  let #(head, rest, remaining) = head_from(slices, <<>>)
  let body = protocol.body_decoder(head)
  let #(lines, framer) =
    body_lines([rest, ..remaining], body, protocol.framer(), [])
  let lines = case protocol.finish(framer) {
    Ok(Some(tail)) -> list.append(lines, [tail])
    _ -> lines
  }
  #(head, lines)
}

fn head_from(
  slices: List(BitArray),
  buf: BitArray,
) -> #(protocol.Head, BitArray, List(BitArray)) {
  case protocol.parse_head(buf) {
    Ok(Some(#(head, rest))) -> #(head, rest, slices)
    Ok(None) -> {
      let assert [next, ..more] = slices
      head_from(more, bit_array.append(buf, next))
    }
    Error(_) -> panic as "malformed head"
  }
}

fn body_lines(
  slices: List(BitArray),
  body: protocol.Body,
  framer: protocol.Framer,
  acc: List(String),
) -> #(List(String), protocol.Framer) {
  case slices {
    [] -> #(acc, framer)
    [bytes, ..rest] -> {
      let assert Ok(#(body, data, _done)) = protocol.feed(body, bytes)
      let assert Ok(#(framer, lines)) = protocol.lines(framer, data)
      body_lines(rest, body, framer, list.append(acc, lines))
    }
  }
}

pub fn stream_fixture_test() {
  use size <- list.each([1, 7, 4096])
  let #(head, lines) = run(helpers.fixture("call-200-stream.raw"), size)
  head.status |> should.equal(200)
  dict.get(head.headers, "content-type")
  |> should.equal(Ok("application/x-ndjson"))
  dict.get(head.headers, "transfer-encoding") |> should.equal(Ok("chunked"))
  list.length(lines) |> should.equal(5)
  let events =
    list.map(lines, fn(line) {
      should.be_ok(json.parse(line, types.event_decoder()))
    })
  let assert [Delta("message", "The"), _, _, _, Done(result)] = events
  result.output |> should.equal(Some("The sky is blue"))
  result.status |> should.equal("incomplete")
  result.warning |> should.equal(Some("insufficientOutputBudget"))
  result.input_tokens |> should.equal(11)
  result.cost |> should.equal(0.0)
}

pub fn error_event_fixture_test() {
  let #(head, lines) = run(helpers.fixture("call-200-error-event.raw"), 3)
  head.status |> should.equal(200)
  let assert [line] = lines
  let assert Ok(Failed(error)) = json.parse(line, types.event_decoder())
  error.type_ |> should.equal(Some("SESSION_UNKNOWN_MODEL"))
  error.retryable |> should.be_false
}

pub fn rejection_fixture_test() {
  let #(head, lines) = run(helpers.fixture("call-400-invalid-envelope.raw"), 11)
  head.status |> should.equal(400)
  dict.get(head.headers, "content-length") |> should.equal(Ok("439"))
  let assert [body] = lines
  let error = should.be_ok(json.parse(body, types.typed_error_decoder()))
  error.type_ |> should.equal(Some("PROTOCOL_INVALID_ENVELOPE"))
}

pub fn health_fixture_test() {
  let #(head, lines) = run(helpers.fixture("health-200.raw"), 9)
  head.status |> should.equal(200)
  let assert [body] = lines
  let health = should.be_ok(json.parse(body, types.health_decoder()))
  health.status |> should.equal("ok")
}

pub fn sized_zero_body_is_done_test() {
  protocol.feed(protocol.Sized(0), <<>>)
  |> should.equal(Ok(#(protocol.Sized(0), <<>>, True)))
}

pub fn chunk_extension_and_trailer_test() {
  let bits =
    bit_array.from_string("5;ext=1\r\nhello\r\n0\r\nX-Trailer: 1\r\n\r\n")
  let assert Ok(#(body, data, done)) =
    protocol.feed(protocol.Chunked(<<>>, protocol.Size), bits)
  data |> should.equal(bit_array.from_string("hello"))
  done |> should.be_true
  body |> should.equal(protocol.Chunked(<<>>, protocol.Complete))
}

pub fn malformed_chunk_terminator_test() {
  let bits = bit_array.from_string("5\r\nhelloXX")
  protocol.feed(protocol.Chunked(<<>>, protocol.Size), bits)
  |> should.equal(Error(protocol.Malformed("malformed chunk terminator")))
}

pub fn framer_skips_blank_lines_and_keeps_tail_test() {
  let assert Ok(#(framer, lines)) =
    protocol.lines(
      protocol.framer(),
      bit_array.from_string("\n{\"a\":1}\n\n{\"b\":2}"),
    )
  lines |> should.equal(["{\"a\":1}"])
  protocol.finish(framer) |> should.equal(Ok(Some("{\"b\":2}")))
}

pub fn framer_line_cap_test() {
  let assert Ok(#(framer, _)) = protocol.lines(protocol.framer(), <<>>)
  let big =
    bit_array.from_string(string_repeat("x", protocol.max_line_bytes + 1))
  protocol.lines(framer, big) |> should.equal(Error(protocol.LineTooLong))
}

@external(erlang, "binary", "copy")
fn binary_copy(bin: BitArray, n: Int) -> BitArray

fn string_repeat(s: String, n: Int) -> String {
  let assert Ok(out) =
    bit_array.to_string(binary_copy(bit_array.from_string(s), n))
  out
}

pub fn conformance_events_decode_test() {
  let fixtures =
    should.be_ok(json.parse(
      helpers.conformance("events.json"),
      decode.dict(decode.string, types.event_decoder()),
    ))
  dict.size(fixtures) |> should.equal(22)
  let assert Ok(Done(tool_use)) = dict.get(fixtures, "done-tool_use")
  tool_use.status |> should.equal("tool_use")
  list.length(tool_use.tool_calls) |> should.equal(1)
  let assert Ok(Failed(no_type)) = dict.get(fixtures, "error-no-type")
  no_type.type_ |> should.equal(None)
  let assert Ok(Failed(trace)) = dict.get(fixtures, "error-severity-trace")
  trace.severity |> should.equal("trace")
  let assert Ok(Done(thinking)) =
    dict.get(fixtures, "done-completed-with-thinking")
  { thinking.thinking_tokens > 0 } |> should.be_true
}
