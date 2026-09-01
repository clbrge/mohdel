(* mohdel client for OCaml: talks to a thin-gate over its unix socket.

   {[
     let client = Mohdel.connect "/tmp/mohdel-data.sock" in
     let envelope =
       Mohdel.Envelope.make ~model:"anthropic/claude-haiku-4-5" ~prompt:"Hello"
       |> Mohdel.Envelope.key key
     in
     match Mohdel.call client (Mohdel.Envelope.to_json envelope) with
     | Error e -> prerr_endline e.message
     | Ok stream -> Mohdel.iter stream (function ... -> ())
   ]}

   Synchronous, stdlib [Unix] transport. Errors are the gate's
   TypedError as [Types.Error.t]. *)

module Protocol = Protocol
module Types = Types
module Envelope = Envelope
module Transport = Transport

type client = {
  socket : string;
  admin_socket : string option;
  transport : Transport.t;
}

let connect ?admin_socket ?(transport = Transport.unix_socket) socket =
  { socket; admin_socket; transport }

let of_protocol_error : Protocol.error -> Types.Error.t = function
  | Protocol.No_response ->
      Types.Error.make ~retryable:true "NET_ERROR" "no response from thin-gate"
  | Protocol.Malformed detail ->
      Types.Error.make ~detail ~retryable:false "PROTOCOL_HTTP_ERROR"
        "malformed response from thin-gate"
  | Protocol.Line_too_long ->
      Types.Error.make ~retryable:false "PROTOCOL_INVALID_EVENT"
        (Printf.sprintf "NDJSON line exceeds %d bytes without newline"
           Protocol.max_line_bytes)

let net_error detail =
  Types.Error.make ~detail ~retryable:true "NET_ERROR" "thin-gate socket error"

let parse_json text =
  try Ok (Yojson.Safe.from_string text)
  with Yojson.Json_error msg -> Error msg

let rejection status body : Types.Error.t =
  let parsed =
    Result.bind (parse_json body) (fun json ->
        Types.decode Types.Error.of_json json)
  in
  match parsed with
  | Ok ({ kind = Some _; _ } as error) -> error
  | _ ->
      Types.Error.make ~retryable:(status >= 500) "PROTOCOL_HTTP_ERROR"
        (Printf.sprintf "thin-gate returned HTTP %d" status)

let open_ client ~socket ~meth ~path ~body =
  match client.transport ~socket ~meth ~path ~body with
  | Error detail -> Error (net_error detail)
  | Ok src -> (
      match Protocol.read_head src with
      | Ok head -> Ok (src, head)
      | Error e ->
          src.close ();
          Error (of_protocol_error e))

let fetch_json client ~socket ~meth ~path ~body ~decode ~malformed =
  match open_ client ~socket ~meth ~path ~body with
  | Error e -> Error e
  | Ok (src, head) -> (
      let body = Protocol.read_body src head in
      src.close ();
      match body with
      | Error e -> Error (of_protocol_error e)
      | Ok text when head.status <> 200 -> Error (rejection head.status text)
      | Ok text -> (
          match Result.bind (parse_json text) (Types.decode decode) with
          | Ok value -> Ok value
          | Error _ ->
              Error
                (Types.Error.make ~retryable:false "PROTOCOL_INVALID_EVENT"
                   malformed)))

type stream = {
  src : Protocol.source;
  next_chunk : unit -> (string option, Protocol.error) result;
  framer : Protocol.framer;
  mutable queue : string list;
  mutable eof : bool;
  mutable closed : bool;
}

(** Closes the socket. Closing before the terminal event is how a caller
    cancels: the gate infers the cancel from the connection close. *)
let close s =
  s.eof <- true;
  s.queue <- [];
  if not s.closed then (
    s.closed <- true;
    s.src.close ())

let fail s error =
  close s;
  Some (Error error)

let parse_event s line =
  match Result.bind (parse_json line) (Types.decode Types.event_of_json) with
  | Ok ((Types.Done _ | Types.Failed _) as event) ->
      close s;
      Some (Ok event)
  | Ok event -> Some (Ok event)
  | Error _ ->
      fail s
        (Types.Error.make ~retryable:false "PROTOCOL_INVALID_EVENT"
           "received a non-Event line from thin-gate")

(** Next event, or [None] once the stream is exhausted. A [Done] or [Failed]
    event is the last one the gate sends. *)
let rec next s : (Types.event, Types.Error.t) result option =
  match s.queue with
  | line :: rest ->
      s.queue <- rest;
      parse_event s line
  | [] when s.eof ->
      close s;
      None
  | [] -> (
      match s.next_chunk () with
      | Error e -> fail s (of_protocol_error e)
      | Ok None -> (
          s.eof <- true;
          match Protocol.finish s.framer with
          | None ->
              close s;
              None
          | Some line -> parse_event s line)
      | Ok (Some chunk) -> (
          match Protocol.feed s.framer chunk with
          | Error e -> fail s (of_protocol_error e)
          | Ok lines ->
              s.queue <- lines;
              next s))

let iter s f =
  let rec go () =
    match next s with
    | None -> ()
    | Some item ->
        f item;
        go ()
  in
  go ()

(** Streams the events of one call. *)
let call client envelope : (stream, Types.Error.t) result =
  let body = Some (Yojson.Safe.to_string envelope) in
  match
    open_ client ~socket:client.socket ~meth:"POST" ~path:Protocol.call_path
      ~body
  with
  | Error e -> Error e
  | Ok (src, head) when head.status <> 200 -> (
      let text = Protocol.read_body src head in
      src.close ();
      match text with
      | Ok text -> Error (rejection head.status text)
      | Error e -> Error (of_protocol_error e))
  | Ok (src, head) ->
      Ok
        {
          src;
          next_chunk = Protocol.body_chunks src head;
          framer = Protocol.framer ();
          queue = [];
          eof = false;
          closed = false;
        }

(** Drains one call: the [done] result, or the [error] event as the error. *)
let collect client envelope : (Types.Answer.t, Types.Error.t) result =
  match call client envelope with
  | Error e -> Error e
  | Ok stream ->
      let rec go () =
        match next stream with
        | None ->
            Error
              (Types.Error.make ~retryable:false "PROTOCOL_INVALID_EVENT"
                 "stream ended without a terminal event")
        | Some (Error e) -> Error e
        | Some (Ok (Types.Done result)) -> Ok result
        | Some (Ok (Types.Failed error)) -> Error error
        | Some (Ok _) -> go ()
      in
      go ()

let image client envelope : (Types.Image.t, Types.Error.t) result =
  match
    fetch_json client ~socket:client.socket ~meth:"POST"
      ~path:Protocol.image_path
      ~body:(Some (Yojson.Safe.to_string envelope))
      ~decode:Types.Image.of_json
      ~malformed:"thin-gate returned a malformed ImageResult"
  with
  | Ok ({ status = "completed"; _ } as result) -> Ok result
  | Ok _ ->
      Error
        (Types.Error.make ~retryable:false "PROTOCOL_INVALID_EVENT"
           "thin-gate returned a malformed ImageResult")
  | Error e -> Error e

let transcription client envelope :
    (Types.Transcription.t, Types.Error.t) result =
  match
    fetch_json client ~socket:client.socket ~meth:"POST"
      ~path:Protocol.transcription_path
      ~body:(Some (Yojson.Safe.to_string envelope))
      ~decode:Types.Transcription.of_json
      ~malformed:"thin-gate returned a malformed TranscriptionResult"
  with
  | Ok ({ status = "completed"; _ } as result) -> Ok result
  | Ok _ ->
      Error
        (Types.Error.make ~retryable:false "PROTOCOL_INVALID_EVENT"
           "thin-gate returned a malformed TranscriptionResult")
  | Error e -> Error e

let health client : (Types.Health.t, Types.Error.t) result =
  match client.admin_socket with
  | None ->
      Error
        (Types.Error.make ~retryable:false "CONFIGURATION_MISSING"
           "health needs the admin socket: pass ~admin_socket to connect")
  | Some socket ->
      fetch_json client ~socket ~meth:"GET" ~path:Protocol.health_path
        ~body:None ~decode:Types.Health.of_json
        ~malformed:"thin-gate returned a malformed health response"
