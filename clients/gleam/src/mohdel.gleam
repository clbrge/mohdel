//// mohdel client for Gleam: talks to a thin-gate over its unix socket.
////
////     let client = mohdel.connect("/tmp/mohdel-data.sock")
////     let envelope = envelope.new(model: "anthropic/claude-haiku-4-5", prompt: "Hello")
////       |> envelope.key(key)
////     mohdel.call(client, envelope.to_json(envelope), fn(event) { ... Continue })

import gleam/bit_array
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import mohdel/protocol.{type Head, type ProtocolError}
import mohdel/transport.{type Source, type Transport}
import mohdel/types.{
  type AnswerResult, type Event, type Health, type ImageResult,
  type TranscriptionResult, type TypedError, Done, Failed, TypedError,
}

pub type Client {
  Client(socket: String, admin_socket: Option(String), transport: Transport)
}

/// What the event callback wants next. `Stop` closes the connection,
/// which is how a caller cancels an in-flight call.
pub type Next {
  Continue
  Stop
}

pub fn connect(socket: String) -> Client {
  Client(socket: socket, admin_socket: None, transport: transport.unix_socket)
}

pub fn with_admin(client: Client, admin_socket: String) -> Client {
  Client(..client, admin_socket: Some(admin_socket))
}

pub fn with_transport(client: Client, transport: Transport) -> Client {
  Client(..client, transport: transport)
}

/// Streams the events of one call to `on_event` until the terminal
/// event, or until the callback returns `Stop`.
pub fn call(
  client: Client,
  envelope: Json,
  on_event: fn(Event) -> Next,
) -> Result(Nil, TypedError) {
  fold(client, envelope, Nil, fn(_, event) { #(Nil, on_event(event)) })
}

/// Drains one call: the `done` result, or the `error` event as the error.
pub fn collect(
  client: Client,
  envelope: Json,
) -> Result(AnswerResult, TypedError) {
  let outcome =
    fold(client, envelope, None, fn(_, event) {
      case event {
        Done(result) -> #(Some(Ok(result)), Continue)
        Failed(error) -> #(Some(Error(error)), Stop)
        _ -> #(None, Continue)
      }
    })
  case outcome {
    Error(e) -> Error(e)
    Ok(Some(terminal)) -> terminal
    Ok(None) ->
      Error(typed(
        "PROTOCOL_INVALID_EVENT",
        "stream ended without a terminal event",
        None,
        False,
      ))
  }
}

/// Threads an accumulator through the events of one call.
pub fn fold(
  client: Client,
  envelope: Json,
  initial: acc,
  on_event: fn(acc, Event) -> #(acc, Next),
) -> Result(acc, TypedError) {
  use #(source, head, rest) <- result.try(open(
    client,
    client.socket,
    "POST",
    protocol.call_path,
    Some(json.to_string(envelope)),
  ))
  case head.status {
    200 ->
      stream(
        source,
        protocol.body_decoder(head),
        protocol.framer(),
        rest,
        initial,
        on_event,
      )
    status -> {
      let body = read_all(source, head, rest)
      source.close()
      case body {
        Ok(bytes) -> Error(rejection(status, bytes))
        Error(e) -> Error(e)
      }
    }
  }
}

pub fn image(
  client: Client,
  envelope: Json,
) -> Result(ImageResult, TypedError) {
  use result <- result.try(fetch_json(
    client,
    client.socket,
    "POST",
    protocol.image_path,
    Some(json.to_string(envelope)),
    types.image_result_decoder(),
    "thin-gate returned a malformed ImageResult",
  ))
  case result.status {
    "completed" -> Ok(result)
    _ ->
      Error(typed(
        "PROTOCOL_INVALID_EVENT",
        "thin-gate returned a malformed ImageResult",
        None,
        False,
      ))
  }
}

pub fn transcription(
  client: Client,
  envelope: Json,
) -> Result(TranscriptionResult, TypedError) {
  use result <- result.try(fetch_json(
    client,
    client.socket,
    "POST",
    protocol.transcription_path,
    Some(json.to_string(envelope)),
    types.transcription_result_decoder(),
    "thin-gate returned a malformed TranscriptionResult",
  ))
  case result.status {
    "completed" -> Ok(result)
    _ ->
      Error(typed(
        "PROTOCOL_INVALID_EVENT",
        "thin-gate returned a malformed TranscriptionResult",
        None,
        False,
      ))
  }
}

pub fn health(client: Client) -> Result(Health, TypedError) {
  case client.admin_socket {
    None ->
      Error(typed(
        "CONFIGURATION_MISSING",
        "health() needs the admin socket: use with_admin",
        None,
        False,
      ))
    Some(socket) ->
      fetch_json(
        client,
        socket,
        "GET",
        protocol.health_path,
        None,
        types.health_decoder(),
        "thin-gate returned a malformed health response",
      )
  }
}

fn typed(
  type_: String,
  message: String,
  detail: Option(String),
  retryable: Bool,
) -> TypedError {
  TypedError(
    type_: Some(type_),
    message: message,
    detail: detail,
    severity: "error",
    retryable: retryable,
  )
}

fn from_protocol_error(error: ProtocolError) -> TypedError {
  case error {
    protocol.NoResponse ->
      typed("NET_ERROR", "no response from thin-gate", None, True)
    protocol.Malformed(detail) ->
      typed(
        "PROTOCOL_HTTP_ERROR",
        "malformed response from thin-gate",
        Some(detail),
        False,
      )
    protocol.LineTooLong ->
      typed(
        "PROTOCOL_INVALID_EVENT",
        "NDJSON line exceeds "
          <> int.to_string(protocol.max_line_bytes)
          <> " bytes without newline",
        None,
        False,
      )
  }
}

fn net_error(detail: String) -> TypedError {
  typed("NET_ERROR", "thin-gate socket error", Some(detail), True)
}

fn open(
  client: Client,
  socket: String,
  method: String,
  path: String,
  body: Option(String),
) -> Result(#(Source, Head, BitArray), TypedError) {
  use source <- result.try(
    client.transport(socket, protocol.request(method, path, body))
    |> result.map_error(net_error),
  )
  case read_head(source, <<>>) {
    Ok(#(head, rest)) -> Ok(#(source, head, rest))
    Error(e) -> {
      source.close()
      Error(e)
    }
  }
}

fn read_head(
  source: Source,
  buf: BitArray,
) -> Result(#(Head, BitArray), TypedError) {
  case protocol.parse_head(buf) {
    Error(e) -> Error(from_protocol_error(e))
    Ok(Some(found)) -> Ok(found)
    Ok(None) ->
      case source.recv() {
        Ok(Some(bytes)) -> read_head(source, bit_array.append(buf, bytes))
        Ok(None) ->
          case bit_array.byte_size(buf) {
            0 -> Error(from_protocol_error(protocol.NoResponse))
            _ ->
              Error(
                from_protocol_error(protocol.Malformed(
                  "connection closed inside the response head",
                )),
              )
          }
        Error(detail) -> Error(net_error(detail))
      }
  }
}

fn read_all(
  source: Source,
  head: Head,
  rest: BitArray,
) -> Result(BitArray, TypedError) {
  drain(source, protocol.body_decoder(head), rest, [])
}

fn drain(
  source: Source,
  body: protocol.Body,
  bytes: BitArray,
  acc: List(BitArray),
) -> Result(BitArray, TypedError) {
  case protocol.feed(body, bytes) {
    Error(e) -> Error(from_protocol_error(e))
    Ok(#(body, data, done)) -> {
      let acc = [data, ..acc]
      case done {
        True -> Ok(bit_array.concat(list.reverse(acc)))
        False ->
          case source.recv() {
            Ok(Some(more)) -> drain(source, body, more, acc)
            Ok(None) ->
              case body_may_end_with_close(body) {
                True -> Ok(bit_array.concat(list.reverse(acc)))
                False ->
                  Error(
                    from_protocol_error(protocol.Malformed(
                      "connection closed inside the body",
                    )),
                  )
              }
            Error(detail) -> Error(net_error(detail))
          }
      }
    }
  }
}

fn body_may_end_with_close(body: protocol.Body) -> Bool {
  case body {
    protocol.UntilClose -> True
    protocol.Chunked(_, protocol.Complete) -> True
    protocol.Sized(0) -> True
    _ -> False
  }
}

fn stream(
  source: Source,
  body: protocol.Body,
  framer: protocol.Framer,
  bytes: BitArray,
  acc: acc,
  on_event: fn(acc, Event) -> #(acc, Next),
) -> Result(acc, TypedError) {
  let fail = fn(e: TypedError) {
    source.close()
    Error(e)
  }
  case protocol.feed(body, bytes) {
    Error(e) -> fail(from_protocol_error(e))
    Ok(#(body, data, done)) ->
      case protocol.lines(framer, data) {
        Error(e) -> fail(from_protocol_error(e))
        Ok(#(framer, lines)) ->
          case dispatch(lines, acc, on_event) {
            Error(e) -> fail(e)
            Ok(#(acc, Stop)) -> {
              source.close()
              Ok(acc)
            }
            Ok(#(acc, Continue)) ->
              case done {
                True -> finish_stream(source, framer, acc, on_event)
                False ->
                  case source.recv() {
                    Ok(Some(more)) ->
                      stream(source, body, framer, more, acc, on_event)
                    Ok(None) ->
                      case body_may_end_with_close(body) {
                        True -> finish_stream(source, framer, acc, on_event)
                        False ->
                          fail(
                            from_protocol_error(protocol.Malformed(
                              "connection closed inside the body",
                            )),
                          )
                      }
                    Error(detail) -> fail(net_error(detail))
                  }
              }
          }
      }
  }
}

fn finish_stream(
  source: Source,
  framer: protocol.Framer,
  acc: acc,
  on_event: fn(acc, Event) -> #(acc, Next),
) -> Result(acc, TypedError) {
  let outcome = case protocol.finish(framer) {
    Error(e) -> Error(from_protocol_error(e))
    Ok(None) -> Ok(acc)
    Ok(Some(line)) ->
      dispatch([line], acc, on_event) |> result.map(fn(pair) { pair.0 })
  }
  source.close()
  outcome
}

fn dispatch(
  lines: List(String),
  acc: acc,
  on_event: fn(acc, Event) -> #(acc, Next),
) -> Result(#(acc, Next), TypedError) {
  case lines {
    [] -> Ok(#(acc, Continue))
    [line, ..rest] ->
      case json.parse(line, types.event_decoder()) {
        Error(_) ->
          Error(typed(
            "PROTOCOL_INVALID_EVENT",
            "received a non-Event line from thin-gate",
            Some(string.slice(line, 0, 200)),
            False,
          ))
        Ok(event) ->
          case on_event(acc, event) {
            #(acc, Stop) -> Ok(#(acc, Stop))
            #(acc, Continue) -> dispatch(rest, acc, on_event)
          }
      }
  }
}

fn rejection(status: Int, body: BitArray) -> TypedError {
  let parsed =
    bit_array.to_string(body)
    |> result.try(fn(text) {
      json.parse(text, types.typed_error_decoder()) |> result.replace_error(Nil)
    })
  case parsed {
    Ok(TypedError(type_: Some(_), ..) as error) -> error
    _ ->
      typed(
        "PROTOCOL_HTTP_ERROR",
        "thin-gate returned HTTP " <> int.to_string(status),
        None,
        status >= 500,
      )
  }
}

fn fetch_json(
  client: Client,
  socket: String,
  method: String,
  path: String,
  body: Option(String),
  decoder: decode.Decoder(t),
  malformed: String,
) -> Result(t, TypedError) {
  use #(source, head, rest) <- result.try(open(
    client,
    socket,
    method,
    path,
    body,
  ))
  let bytes = read_all(source, head, rest)
  source.close()
  use bytes <- result.try(bytes)
  case head.status {
    200 ->
      bit_array.to_string(bytes)
      |> result.replace_error(Nil)
      |> result.try(fn(text) {
        json.parse(text, decoder) |> result.replace_error(Nil)
      })
      |> result.replace_error(typed(
        "PROTOCOL_INVALID_EVENT",
        malformed,
        None,
        False,
      ))
    status -> Error(rejection(status, bytes))
  }
}
