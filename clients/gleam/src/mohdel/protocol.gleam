//// Wire layer for the thin-gate HTTP surface: request bytes, response
//// head, chunked bodies, NDJSON framing. Pure Gleam, push-style: feed
//// the bytes a socket hands you, get parsed pieces back.

import gleam/bit_array
import gleam/dict.{type Dict}
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string

pub const max_line_bytes = 16_777_216

pub const call_path = "/v1/call"

pub const image_path = "/v1/image"

pub const transcription_path = "/v1/transcription"

pub const health_path = "/v1/health"

pub type ProtocolError {
  /// The peer closed before sending a response head.
  NoResponse
  /// Bytes that do not form a valid HTTP/1.1 response.
  Malformed(String)
  /// One NDJSON line exceeded `max_line_bytes` without a newline.
  LineTooLong
}

pub type Head {
  Head(status: Int, headers: Dict(String, String))
}

pub fn request(method: String, path: String, body: Option(String)) -> BitArray {
  let base =
    method
    <> " "
    <> path
    <> " HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n"
  case body {
    Some(b) ->
      bit_array.from_string(
        base
        <> "Content-Type: application/json\r\nContent-Length: "
        <> int.to_string(string.byte_size(b))
        <> "\r\n\r\n"
        <> b,
      )
    None -> bit_array.from_string(base <> "\r\n")
  }
}

fn index_of(
  haystack: BitArray,
  needle: BitArray,
  from: Int,
) -> Result(Int, Nil) {
  case bit_array.slice(haystack, from, bit_array.byte_size(needle)) {
    Error(_) -> Error(Nil)
    Ok(window) ->
      case window == needle {
        True -> Ok(from)
        False -> index_of(haystack, needle, from + 1)
      }
  }
}

fn take(bits: BitArray, at: Int, length: Int) -> BitArray {
  case bit_array.slice(bits, at, length) {
    Ok(part) -> part
    Error(_) -> <<>>
  }
}

fn rest_from(bits: BitArray, at: Int) -> BitArray {
  take(bits, at, bit_array.byte_size(bits) - at)
}

/// `Ok(None)` while the head is incomplete; `Ok(Some(#(head, rest)))`
/// once the blank line has arrived, `rest` being the bytes after it.
pub fn parse_head(
  buf: BitArray,
) -> Result(Option(#(Head, BitArray)), ProtocolError) {
  case index_of(buf, <<"\r\n\r\n":utf8>>, 0) {
    Error(_) -> Ok(None)
    Ok(i) -> {
      use text <- result.try(
        bit_array.to_string(take(buf, 0, i))
        |> result.replace_error(Malformed("non-UTF-8 response head")),
      )
      case string.split(text, "\r\n") {
        [status_line, ..header_lines] -> {
          use status <- result.try(parse_status(status_line))
          let headers =
            list.fold(header_lines, dict.new(), fn(acc, line) {
              case string.split_once(line, ":") {
                Ok(#(k, v)) ->
                  dict.insert(
                    acc,
                    string.lowercase(string.trim(k)),
                    string.trim(v),
                  )
                Error(_) -> acc
              }
            })
          Ok(Some(#(Head(status, headers), rest_from(buf, i + 4))))
        }
        [] -> Error(Malformed("empty response head"))
      }
    }
  }
}

fn parse_status(line: String) -> Result(Int, ProtocolError) {
  case string.split(line, " ") {
    ["HTTP/1.1", code, ..] | ["HTTP/1.0", code, ..] ->
      int.parse(code)
      |> result.replace_error(Malformed("malformed status line: " <> line))
    _ -> Error(Malformed("malformed status line: " <> line))
  }
}

pub type Body {
  Chunked(buf: BitArray, state: ChunkState)
  Sized(remaining: Int)
  UntilClose
}

pub type ChunkState {
  Size
  Data(remaining: Int)
  Crlf
  Trailer
  Complete
}

pub fn body_decoder(head: Head) -> Body {
  let chunked = case dict.get(head.headers, "transfer-encoding") {
    Ok(te) -> string.contains(string.lowercase(te), "chunked")
    Error(_) -> False
  }
  case chunked, dict.get(head.headers, "content-length") {
    True, _ -> Chunked(<<>>, Size)
    False, Ok(len) ->
      case int.parse(string.trim(len)) {
        Ok(n) -> Sized(n)
        Error(_) -> UntilClose
      }
    False, Error(_) -> UntilClose
  }
}

/// Feeds bytes into the body decoder. Returns the next decoder state,
/// the decoded body bytes produced, and whether the body is complete
/// (never `True` for `UntilClose`: that body ends with the connection).
pub fn feed(
  body: Body,
  bytes: BitArray,
) -> Result(#(Body, BitArray, Bool), ProtocolError) {
  case body {
    UntilClose -> Ok(#(UntilClose, bytes, False))
    Sized(remaining) -> {
      let n = int.min(remaining, bit_array.byte_size(bytes))
      let left = remaining - n
      Ok(#(Sized(left), take(bytes, 0, n), left == 0))
    }
    Chunked(buf, state) -> dechunk(bit_array.append(buf, bytes), state, [])
  }
}

fn dechunk(
  buf: BitArray,
  state: ChunkState,
  out: List(BitArray),
) -> Result(#(Body, BitArray, Bool), ProtocolError) {
  let finish = fn(buf, state, done) {
    Ok(#(Chunked(buf, state), bit_array.concat(list.reverse(out)), done))
  }
  case state {
    Complete -> finish(buf, Complete, True)
    Size ->
      case index_of(buf, <<"\r\n":utf8>>, 0) {
        Error(_) -> finish(buf, Size, False)
        Ok(i) -> {
          use size <- result.try(parse_chunk_size(take(buf, 0, i)))
          let rest = rest_from(buf, i + 2)
          case size {
            0 -> dechunk(rest, Trailer, out)
            _ -> dechunk(rest, Data(size), out)
          }
        }
      }
    Data(remaining) -> {
      let n = int.min(remaining, bit_array.byte_size(buf))
      case n {
        0 -> finish(buf, Data(remaining), False)
        _ -> {
          let out = [take(buf, 0, n), ..out]
          let rest = rest_from(buf, n)
          case remaining - n {
            0 -> dechunk(rest, Crlf, out)
            left -> finish(rest, Data(left), False) |> with_out(out)
          }
        }
      }
    }
    Crlf ->
      case bit_array.byte_size(buf) < 2 {
        True -> finish(buf, Crlf, False)
        False ->
          case take(buf, 0, 2) == <<"\r\n":utf8>> {
            True -> dechunk(rest_from(buf, 2), Size, out)
            False -> Error(Malformed("malformed chunk terminator"))
          }
      }
    Trailer ->
      case index_of(buf, <<"\r\n":utf8>>, 0) {
        Error(_) -> finish(buf, Trailer, False)
        Ok(0) -> finish(rest_from(buf, 2), Complete, True)
        Ok(i) -> dechunk(rest_from(buf, i + 2), Trailer, out)
      }
  }
}

fn with_out(
  r: Result(#(Body, BitArray, Bool), ProtocolError),
  out: List(BitArray),
) -> Result(#(Body, BitArray, Bool), ProtocolError) {
  case r {
    Ok(#(body, _, done)) ->
      Ok(#(body, bit_array.concat(list.reverse(out)), done))
    Error(e) -> Error(e)
  }
}

fn parse_chunk_size(line: BitArray) -> Result(Int, ProtocolError) {
  use text <- result.try(
    bit_array.to_string(line)
    |> result.replace_error(Malformed("malformed chunk size")),
  )
  let hex = case string.split_once(text, ";") {
    Ok(#(h, _)) -> h
    Error(_) -> text
  }
  int.base_parse(string.trim(hex), 16)
  |> result.replace_error(Malformed("malformed chunk size: " <> text))
}

pub opaque type Framer {
  Framer(buf: BitArray)
}

pub fn framer() -> Framer {
  Framer(<<>>)
}

/// Splits decoded body bytes into NDJSON documents. `\n` is the only
/// terminator; blank lines are skipped; the cap applies to bytes that
/// have not yet seen a newline.
pub fn lines(
  framer: Framer,
  bytes: BitArray,
) -> Result(#(Framer, List(String)), ProtocolError) {
  let buf = bit_array.append(framer.buf, bytes)
  use #(rest, out) <- result.try(split_lines(buf, []))
  case bit_array.byte_size(rest) > max_line_bytes {
    True -> Error(LineTooLong)
    False -> Ok(#(Framer(rest), list.reverse(out)))
  }
}

fn split_lines(
  buf: BitArray,
  out: List(String),
) -> Result(#(BitArray, List(String)), ProtocolError) {
  case index_of(buf, <<"\n":utf8>>, 0) {
    Error(_) -> Ok(#(buf, out))
    Ok(i) -> {
      use line <- result.try(line_text(take(buf, 0, i)))
      let out = case line {
        "" -> out
        _ -> [line, ..out]
      }
      split_lines(rest_from(buf, i + 1), out)
    }
  }
}

/// The final document, if the stream ended without a trailing newline.
pub fn finish(framer: Framer) -> Result(Option(String), ProtocolError) {
  use line <- result.try(line_text(framer.buf))
  case line {
    "" -> Ok(None)
    _ -> Ok(Some(line))
  }
}

fn line_text(bits: BitArray) -> Result(String, ProtocolError) {
  bit_array.to_string(bits)
  |> result.map(string.trim)
  |> result.replace_error(Malformed("non-UTF-8 NDJSON line"))
}
