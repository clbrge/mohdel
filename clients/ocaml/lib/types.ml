(* Wire types of the thin-gate surface and their decoders. Names
   follow PROTOCOL.md: camelCase on the wire, snake_case here. *)

open Yojson.Safe.Util

let decode f json = try Ok (f json) with Type_error (msg, _) -> Error msg
let opt_string json name = member name json |> to_string_option
let opt_int json name = member name json |> to_int_option
let number json = to_number json

let opt_number json name =
  match member name json with `Null -> None | v -> Some (number v)

module Error = struct
  type t = {
    kind : string option;
    message : string;
    detail : string option;
    severity : string;
    retryable : bool;
  }

  let of_json json =
    {
      kind = opt_string json "type";
      message = member "message" json |> to_string;
      detail = opt_string json "detail";
      severity = Option.value (opt_string json "severity") ~default:"error";
      retryable =
        (match member "retryable" json with `Bool b -> b | _ -> false);
    }

  let make ?detail ~retryable kind message =
    { kind = Some kind; message; detail; severity = "error"; retryable }
end

type timestamps = { start : string; first : string; end_ : string }

let timestamps_of_json json =
  {
    start = member "start" json |> to_string;
    first = member "first" json |> to_string;
    end_ = member "end" json |> to_string;
  }

type tool_call = {
  id : string;
  name : string;
  arguments : Yojson.Safe.t;
  thought_signature : string option;
}

let tool_call_of_json json =
  {
    id = member "id" json |> to_string;
    name = member "name" json |> to_string;
    arguments = member "arguments" json;
    thought_signature = opt_string json "thoughtSignature";
  }

module Answer = struct
  type t = {
    status : string;
    output : string option;
    input_tokens : int;
    output_tokens : int;
    thinking_tokens : int;
    cache_write_input_tokens : int option;
    cache_write_1h_input_tokens : int option;
    cache_read_input_tokens : int option;
    cost : float;
    timestamps : timestamps;
    warning : string option;
    tool_calls : tool_call list;
    max_inter_frame_ms : int option;
    reasoning : string option;
    speed : string option;
    served_speed : string option;
  }

  let of_json json =
    {
      status = member "status" json |> to_string;
      output = opt_string json "output";
      input_tokens = member "inputTokens" json |> to_int;
      output_tokens = member "outputTokens" json |> to_int;
      thinking_tokens = Option.value (opt_int json "thinkingTokens") ~default:0;
      cache_write_input_tokens = opt_int json "cacheWriteInputTokens";
      cache_write_1h_input_tokens = opt_int json "cacheWrite1hInputTokens";
      cache_read_input_tokens = opt_int json "cacheReadInputTokens";
      cost = member "cost" json |> number;
      timestamps = member "timestamps" json |> timestamps_of_json;
      warning = opt_string json "warning";
      tool_calls =
        (match member "toolCalls" json with
        | `Null -> []
        | v -> to_list v |> List.map tool_call_of_json);
      max_inter_frame_ms = opt_int json "maxInterFrameMs";
      reasoning = opt_string json "reasoning";
      speed = opt_string json "speed";
      served_speed = opt_string json "servedSpeed";
    }
end

type event =
  | Delta of { kind : string; delta : string }
      (** [kind] is ["message"] or ["function_call"]. *)
  | Idle of int  (** Milliseconds since the last real event. *)
  | Done of Answer.t
  | Failed of Error.t

let event_of_json json =
  match member "type" json |> to_string with
  | "delta" ->
      let d = member "delta" json in
      Delta
        {
          kind = member "type" d |> to_string;
          delta = member "delta" d |> to_string;
        }
  | "idle" -> Idle (member "sinceMs" json |> to_int)
  | "done" -> Done (member "result" json |> Answer.of_json)
  | "error" -> Failed (member "error" json |> Error.of_json)
  | other -> raise (Type_error ("not an event: " ^ other, json))

module Image = struct
  type data = {
    mime_type : string;
    url : string option;
    base64 : string option;
  }

  type t = {
    status : string;
    images : data list;
    seed : int option;
    timestamps : timestamps;
  }

  let data_of_json json =
    {
      mime_type = member "mimeType" json |> to_string;
      url = opt_string json "url";
      base64 = opt_string json "base64";
    }

  let of_json json =
    {
      status = member "status" json |> to_string;
      images = member "images" json |> to_list |> List.map data_of_json;
      seed = opt_int json "seed";
      timestamps = member "timestamps" json |> timestamps_of_json;
    }
end

module Transcription = struct
  type t = {
    status : string;
    text : string;
    language : string option;
    duration_seconds : float option;
    input_tokens : int option;
    output_tokens : int option;
    cost : float;
    timestamps : timestamps;
  }

  let of_json json =
    {
      status = member "status" json |> to_string;
      text = member "text" json |> to_string;
      language = opt_string json "language";
      duration_seconds = opt_number json "durationSeconds";
      input_tokens = opt_int json "inputTokens";
      output_tokens = opt_int json "outputTokens";
      cost = Option.value (opt_number json "cost") ~default:0.;
      timestamps = member "timestamps" json |> timestamps_of_json;
    }
end

module Health = struct
  type t = { status : string; version : string; uptime_ms : int }

  let of_json json =
    {
      status = member "status" json |> to_string;
      version = member "version" json |> to_string;
      uptime_ms = member "uptime_ms" json |> to_int;
    }
end
