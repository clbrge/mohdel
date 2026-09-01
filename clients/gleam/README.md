# mohdel — Gleam client

Talks to a running [mohdel](../../README.md) thin-gate over its unix socket:
chat completions with streaming, tool calls and vision, image generation,
speech to text, per-call USD cost. Erlang target, OTP 26+.

## Install

Until it is on Hex, add it as a path dependency:

```toml
[dependencies]
mohdel = { path = "../mohdel/clients/gleam" }
```

## Use

```gleam
import gleam/io
import mohdel.{Continue}
import mohdel/envelope
import mohdel/types.{Delta, Done, Failed}

pub fn main() {
  let client =
    mohdel.connect("/tmp/mohdel-data.sock")
    |> mohdel.with_admin("/tmp/mohdel-admin.sock")

  let call =
    envelope.new(model: "anthropic/claude-haiku-4-5", prompt: "Hello")
    |> envelope.key(key)
    |> envelope.output_budget(200)
    |> envelope.to_json

  // stream
  let assert Ok(Nil) =
    mohdel.call(client, call, fn(event) {
      case event {
        Delta(_, text) -> io.print(text)
        Done(result) -> io.println("\n$" <> float.to_string(result.cost))
        Failed(error) -> io.println(error.message)
        _ -> Nil
      }
      Continue
    })

  // or drain: the `done` result, or the `error` event as the error
  let assert Ok(result) = mohdel.collect(client, call)

  // accumulate anything across the stream
  let assert Ok(deltas) =
    mohdel.fold(client, call, 0, fn(n, event) {
      case event {
        Delta(_, _) -> #(n + 1, Continue)
        _ -> #(n, Continue)
      }
    })

  mohdel.image(client, image_envelope)          // Result(ImageResult, TypedError)
  mohdel.transcription(client, audio_envelope)  // Result(TranscriptionResult, TypedError)
  mohdel.health(client)                         // Result(Health, TypedError)
}
```

Returning `Stop` from the callback closes the connection, which is how a
caller cancels an in-flight call.

`envelope` covers the common fields (`key`, `auth_id`, `call_id`,
`output_budget`, `output_effort`, `identifier`, `prompt_json` for a
structured prompt); anything else goes in with `envelope.with("tools", json)`.
`mohdel.call` and friends take the `Json` itself, so any builder works.

Event, result and error shapes are the ones in
[PROTOCOL.md](../../PROTOCOL.md) (§3.1, §4, §10): `types.Event`,
`types.AnswerResult`, `types.TypedError` (`type_` is the tag callers branch
on). Client-side tags: `NET_ERROR` (socket; retryable),
`PROTOCOL_HTTP_ERROR` (malformed or non-JSON non-200; retryable for 5xx),
`PROTOCOL_INVALID_EVENT` (non-event line, over-long line, malformed result),
`CONFIGURATION_MISSING` (`health` without `with_admin`).

## Tests

```sh
gleam test
```

The live tests run only with `MOHDEL_GATE_SOCKET` set (optionally
`MOHDEL_GATE_ADMIN_SOCKET`, `MOHDEL_LIVE_MODEL`, `MOHDEL_LIVE_KEY`); the rest
replay the captured gate responses in `test/conformance/gate/` and decode
every event in `test/conformance/events.json`.
