import gleam/bit_array
import gleam/option.{type Option}
import mohdel/transport.{type Source, type Transport, Source}
import simplifile

pub type Ref

@external(erlang, "mohdel_test_ffi", "queue_new")
fn queue_new(slices: List(BitArray)) -> Ref

@external(erlang, "mohdel_test_ffi", "queue_next")
fn queue_next(ref: Ref) -> Result(Option(BitArray), String)

@external(erlang, "mohdel_test_ffi", "log_new")
pub fn log_new() -> Ref

@external(erlang, "mohdel_test_ffi", "log_push")
pub fn log_push(ref: Ref, item: BitArray) -> Nil

@external(erlang, "mohdel_test_ffi", "log_all")
pub fn log_all(ref: Ref) -> List(BitArray)

pub fn fixture(name: String) -> BitArray {
  let assert Ok(bits) =
    simplifile.read_bits("../../test/conformance/gate/" <> name)
  bits
}

pub fn conformance(name: String) -> String {
  let assert Ok(text) = simplifile.read("../../test/conformance/" <> name)
  text
}

pub fn slices(bits: BitArray, size: Int) -> List(BitArray) {
  case bit_array.byte_size(bits) {
    0 -> []
    n -> {
      let take = case n < size {
        True -> n
        False -> size
      }
      let assert Ok(head) = bit_array.slice(bits, 0, take)
      let assert Ok(tail) = bit_array.slice(bits, take, n - take)
      [head, ..slices(tail, size)]
    }
  }
}

/// A source replaying `bits` in `size`-byte reads.
pub fn source(bits: BitArray, size: Int) -> Source {
  let queue = queue_new(slices(bits, size))
  Source(recv: fn() { queue_next(queue) }, close: fn() { Nil })
}

/// A transport answering every request with `bits`, logging requests.
pub fn transport(bits: BitArray, size: Int, log: Ref) -> Transport {
  fn(_socket, request) {
    log_push(log, request)
    Ok(source(bits, size))
  }
}

pub fn json_response(body: String) -> BitArray {
  bit_array.from_string(
    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: "
    <> int_to_string(bit_array.byte_size(bit_array.from_string(body)))
    <> "\r\n\r\n"
    <> body,
  )
}

@external(erlang, "erlang", "integer_to_binary")
fn int_to_string(i: Int) -> String
