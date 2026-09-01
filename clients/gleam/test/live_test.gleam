//// Runs only against a live thin-gate: set MOHDEL_GATE_SOCKET (and
//// MOHDEL_GATE_ADMIN_SOCKET for health). MOHDEL_LIVE_MODEL picks the
//// catalog key (default local/llama3.1-8b); MOHDEL_LIVE_KEY the auth key.

import envoy
import gleam/json
import gleam/option.{Some}
import gleam/result
import gleeunit/should
import mohdel.{Continue, Stop}
import mohdel/envelope
import mohdel/types.{Delta, Done, Failed}

fn live() -> Result(#(mohdel.Client, String), Nil) {
  use socket <- result.try(envoy.get("MOHDEL_GATE_SOCKET"))
  let client = case envoy.get("MOHDEL_GATE_ADMIN_SOCKET") {
    Ok(admin) -> mohdel.connect(socket) |> mohdel.with_admin(admin)
    Error(_) -> mohdel.connect(socket)
  }
  Ok(#(
    client,
    result.unwrap(envoy.get("MOHDEL_LIVE_MODEL"), "local/llama3.1-8b"),
  ))
}

fn envelope_for(model: String) -> envelope.Envelope {
  envelope.new(model: model, prompt: "Say the single word \"hi\".")
  |> envelope.auth_id("gleam-live")
  |> envelope.key(result.unwrap(envoy.get("MOHDEL_LIVE_KEY"), ""))
  |> envelope.output_budget(20)
}

pub fn live_stream_test() {
  case live() {
    Error(_) -> Nil
    Ok(#(client, model)) -> {
      let #(deltas, result) =
        should.be_ok(
          mohdel.fold(
            client,
            envelope.to_json(envelope_for(model)),
            #(0, Error(Nil)),
            fn(acc, event) {
              case event {
                Delta(_, _) -> #(#(acc.0 + 1, acc.1), Continue)
                Done(result) -> #(#(acc.0, Ok(result)), Continue)
                Failed(error) -> panic as { "error event: " <> error.message }
                _ -> #(acc, Continue)
              }
            },
          ),
        )
      { deltas > 0 } |> should.be_true
      let result = should.be_ok(result)
      result.status |> should.equal("completed")
      { result.input_tokens > 0 } |> should.be_true
      { result.output_tokens > 0 } |> should.be_true
    }
  }
}

pub fn live_budget_incomplete_test() {
  case live() {
    Error(_) -> Nil
    Ok(#(client, model)) -> {
      let envelope =
        envelope_for(model)
        |> envelope.output_budget(1)
        |> envelope.prompt_json(json.string(
          "Write a detailed essay about tigers.",
        ))
      let result =
        should.be_ok(mohdel.collect(client, envelope.to_json(envelope)))
      result.status |> should.equal("incomplete")
      result.warning |> should.equal(Some("insufficientOutputBudget"))
    }
  }
}

pub fn live_stop_cancels_then_next_call_works_test() {
  case live() {
    Error(_) -> Nil
    Ok(#(client, model)) -> {
      let long =
        envelope_for(model)
        |> envelope.output_budget(200)
        |> envelope.prompt_json(json.string(
          "Count slowly from 1 to 100, one number per line.",
        ))
      mohdel.call(client, envelope.to_json(long), fn(_) { Stop })
      |> should.be_ok
      let result =
        should.be_ok(mohdel.collect(
          client,
          envelope.to_json(envelope_for(model)),
        ))
      result.status |> should.equal("completed")
    }
  }
}

pub fn live_health_test() {
  case live(), envoy.get("MOHDEL_GATE_ADMIN_SOCKET") {
    Ok(#(client, _)), Ok(_) -> {
      let health = should.be_ok(mohdel.health(client))
      health.status |> should.equal("ok")
    }
    _, _ -> Nil
  }
}
