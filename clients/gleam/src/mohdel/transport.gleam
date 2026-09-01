//// Byte transport to the gate. The default opens the unix socket with
//// `gen_tcp`; tests substitute a `Transport` that replays bytes.

import gleam/option.{type Option}
import gleam/result

pub type Socket

/// `recv` yields the next bytes, `Ok(None)` at end of stream.
pub type Source {
  Source(recv: fn() -> Result(Option(BitArray), String), close: fn() -> Nil)
}

/// Opens a connection to the socket path and sends the request bytes.
pub type Transport =
  fn(String, BitArray) -> Result(Source, String)

@external(erlang, "mohdel_ffi", "connect")
fn connect(path: String) -> Result(Socket, String)

@external(erlang, "mohdel_ffi", "send")
fn send(socket: Socket, bytes: BitArray) -> Result(Nil, String)

@external(erlang, "mohdel_ffi", "recv")
fn recv(socket: Socket) -> Result(Option(BitArray), String)

@external(erlang, "mohdel_ffi", "close")
fn close(socket: Socket) -> Nil

pub fn unix_socket(path: String, request: BitArray) -> Result(Source, String) {
  use socket <- result.try(connect(path))
  case send(socket, request) {
    Ok(Nil) ->
      Ok(Source(recv: fn() { recv(socket) }, close: fn() { close(socket) }))
    Error(reason) -> {
      close(socket)
      Error(reason)
    }
  }
}
