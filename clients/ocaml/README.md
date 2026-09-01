# mohdel — OCaml client

Talks to a running [mohdel](../../README.md) thin-gate over its unix socket:
chat completions with streaming, tool calls and vision, image generation,
speech to text, per-call USD cost. Synchronous, stdlib `Unix` transport,
`yojson`; OCaml 4.14+.

Blocking on purpose: no Lwt/Eio dependency, so it drops into any program
(and into Lwt/Eio code through their blocking-call helpers).

## Install

Until it is on opam:

```sh
opam pin add mohdel ./clients/ocaml
```

## Use

```ocaml
let () =
  let client = Mohdel.connect ~admin_socket:"/tmp/mohdel-admin.sock" "/tmp/mohdel-data.sock" in
  let envelope =
    Mohdel.Envelope.make ~model:"anthropic/claude-haiku-4-5" ~prompt:"Hello"
    |> Mohdel.Envelope.key key
    |> Mohdel.Envelope.output_budget 200
    |> Mohdel.Envelope.to_json
  in
  (* stream *)
  (match Mohdel.call client envelope with
  | Error e -> prerr_endline e.message
  | Ok stream ->
      Mohdel.iter stream (function
        | Ok (Mohdel.Types.Delta { delta; _ }) -> print_string delta
        | Ok (Mohdel.Types.Done r) -> Printf.printf "\n$%g\n" r.cost
        | Ok (Mohdel.Types.Failed e) -> prerr_endline e.message
        | Ok (Mohdel.Types.Idle _) -> ()
        | Error e -> prerr_endline e.message));
  (* or drain: the done result, or the error event as the error *)
  match Mohdel.collect client envelope with
  | Ok r -> print_endline (Option.value r.output ~default:"")
  | Error e -> prerr_endline e.message
```

`Mohdel.next stream` pulls one event; `Mohdel.close stream` before the
terminal event closes the connection, which is how a caller cancels.
`Mohdel.image`, `Mohdel.transcription` and `Mohdel.health` are one-shot.

`Envelope` covers the common fields (`key`, `auth_id`, `call_id`,
`output_budget`, `output_effort`, `identifier`, `prompt_json` for a
structured prompt); anything else goes in with `Envelope.with_field`. The
call functions take the `Yojson.Safe.t` itself, so any builder works.

Event, result and error shapes are the ones in
[PROTOCOL.md](../../PROTOCOL.md) (§3.1, §4, §10): `Types.event`,
`Types.Answer.t`, `Types.Error.t` (`kind` is the tag callers branch on).
Client-side tags: `NET_ERROR` (socket; retryable), `PROTOCOL_HTTP_ERROR`
(malformed or non-JSON non-200; retryable for 5xx), `PROTOCOL_INVALID_EVENT`
(non-event line, over-long line, malformed result), `CONFIGURATION_MISSING`
(`health` without `~admin_socket`).

## Tests

```sh
dune test
```

The live tests run only with `MOHDEL_GATE_SOCKET` set (optionally
`MOHDEL_GATE_ADMIN_SOCKET`, `MOHDEL_LIVE_MODEL`, `MOHDEL_LIVE_KEY`); the rest
replay the captured gate responses in `test/conformance/gate/` and decode
every event in `test/conformance/events.json`.
