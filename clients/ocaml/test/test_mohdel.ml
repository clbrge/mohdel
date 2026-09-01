open Mohdel

let root =
  match Sys.getenv_opt "MOHDEL_ROOT" with
  | Some r -> r
  | None -> failwith "MOHDEL_ROOT is unset (dune sets it; see test/dune)"

let read_file path = In_channel.with_open_bin path In_channel.input_all

let fixture name =
  read_file (Filename.concat root ("test/conformance/gate/" ^ name))

let conformance name =
  read_file (Filename.concat root ("test/conformance/" ^ name))

let strip_cr line =
  let n = String.length line in
  if n > 0 && line.[n - 1] = '\r' then String.sub line 0 (n - 1) else line

(* Source over a byte string, honouring the source contract. *)
let source ?(closed = ref false) bytes : Protocol.source =
  let pos = ref 0 and len = String.length bytes in
  {
    read_line =
      (fun () ->
        if !pos >= len then None
        else
          match String.index_from_opt bytes !pos '\n' with
          | Some i ->
              let line = String.sub bytes !pos (i - !pos) in
              pos := i + 1;
              Some (strip_cr line)
          | None ->
              let line = String.sub bytes !pos (len - !pos) in
              pos := len;
              Some (strip_cr line));
    read =
      (fun n ->
        if !pos >= len then None
        else
          let take = min n (len - !pos) in
          let data = String.sub bytes !pos take in
          pos := !pos + take;
          Some data);
    close = (fun () -> closed := true);
  }

type recorded = {
  socket : string;
  meth : string;
  path : string;
  body : string option;
}

let client bytes =
  let log = ref [] and closed = ref false in
  let transport ~socket ~meth ~path ~body =
    log := { socket; meth; path; body } :: !log;
    Ok (source ~closed bytes)
  in
  ( connect ~admin_socket:"/tmp/admin.sock" ~transport "/tmp/data.sock",
    log,
    closed )

let envelope () =
  Envelope.make ~model:"local/llama3.1-8b" ~prompt:"why is the sky blue"
  |> Envelope.call_id "c-1" |> Envelope.auth_id "u-1"
  |> Envelope.output_budget 4 |> Envelope.to_json

let kind_of (e : Types.Error.t) = e.kind
let err_kind = Alcotest.(option string)

let json_response body =
  Printf.sprintf
    "HTTP/1.1 200 OK\r\n\
     content-type: application/json\r\n\
     content-length: %d\r\n\
     \r\n\
     %s"
    (String.length body) body

let get = function Ok v -> v | Error (e : Types.Error.t) -> failwith e.message
let get_err = function Error e -> e | Ok _ -> failwith "expected an error"

let ok_protocol = function
  | Ok v -> v
  | Error (Protocol.Malformed m) -> failwith m
  | Error Protocol.No_response -> failwith "no response"
  | Error Protocol.Line_too_long -> failwith "line too long"

let run_fixture bytes =
  let src = source bytes in
  let head = ok_protocol (Protocol.read_head src) in
  let next = Protocol.body_chunks src head in
  let framer = Protocol.framer () in
  let rec go acc =
    match ok_protocol (next ()) with
    | None -> acc
    | Some chunk -> go (acc @ ok_protocol (Protocol.feed framer chunk))
  in
  let lines = go [] in
  let lines =
    match Protocol.finish framer with Some t -> lines @ [ t ] | None -> lines
  in
  (head, lines)

let event line =
  get
    (Types.decode Types.event_of_json (Yojson.Safe.from_string line)
    |> Result.map_error (fun m -> Types.Error.make ~retryable:false "TEST" m))

(* ---------- protocol ---------- *)

let test_request () =
  Alcotest.(check string)
    "POST"
    "POST /v1/call HTTP/1.1\r\n\
     Host: localhost\r\n\
     Connection: close\r\n\
     Content-Type: application/json\r\n\
     Content-Length: 7\r\n\
     \r\n\
     {\"a\":1}"
    (Protocol.request ~meth:"POST" ~path:"/v1/call" ~body:"{\"a\":1}" ());
  Alcotest.(check string)
    "GET"
    "GET /v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    (Protocol.request ~meth:"GET" ~path:"/v1/health" ())

let test_stream_fixture () =
  let head, lines = run_fixture (fixture "call-200-stream.raw") in
  Alcotest.(check int) "status" 200 head.status;
  Alcotest.(check (option string))
    "content-type" (Some "application/x-ndjson")
    (Protocol.header head "content-type");
  Alcotest.(check (option string))
    "chunked" (Some "chunked")
    (Protocol.header head "transfer-encoding");
  Alcotest.(check int) "lines" 5 (List.length lines);
  (match event (List.hd lines) with
  | Types.Delta { kind = "message"; delta = "The" } -> ()
  | _ -> Alcotest.fail "first event");
  match event (List.nth lines 4) with
  | Types.Done r ->
      Alcotest.(check (option string))
        "output" (Some "The sky is blue") r.output;
      Alcotest.(check string) "status" "incomplete" r.status;
      Alcotest.(check (option string))
        "warning" (Some "insufficientOutputBudget") r.warning;
      Alcotest.(check int) "input" 11 r.input_tokens;
      Alcotest.(check (float 0.)) "cost" 0. r.cost
  | _ -> Alcotest.fail "last event"

let test_error_event_fixture () =
  let head, lines = run_fixture (fixture "call-200-error-event.raw") in
  Alcotest.(check int) "status" 200 head.status;
  match lines with
  | [ line ] -> (
      match event line with
      | Types.Failed e ->
          Alcotest.check err_kind "kind" (Some "SESSION_UNKNOWN_MODEL") e.kind
      | _ -> Alcotest.fail "not an error event")
  | _ -> Alcotest.fail "one line expected"

let test_rejection_fixture () =
  let head, lines = run_fixture (fixture "call-400-invalid-envelope.raw") in
  Alcotest.(check int) "status" 400 head.status;
  Alcotest.(check (option string))
    "content-length" (Some "439")
    (Protocol.header head "content-length");
  let e =
    get
      (Types.decode Types.Error.of_json
         (Yojson.Safe.from_string (List.hd lines))
      |> Result.map_error (fun m -> Types.Error.make ~retryable:false "TEST" m)
      )
  in
  Alcotest.check err_kind "kind" (Some "PROTOCOL_INVALID_ENVELOPE") e.kind;
  Alcotest.(check bool) "retryable" false e.retryable

let test_health_fixture () =
  let head, lines = run_fixture (fixture "health-200.raw") in
  Alcotest.(check int) "status" 200 head.status;
  let h =
    get
      (Types.decode Types.Health.of_json
         (Yojson.Safe.from_string (List.hd lines))
      |> Result.map_error (fun m -> Types.Error.make ~retryable:false "TEST" m)
      )
  in
  Alcotest.(check string) "ok" "ok" h.status

let chunked_head =
  { Protocol.status = 200; headers = [ ("transfer-encoding", "chunked") ] }

let test_chunk_extension_and_trailer () =
  let src = source "5;ext=1\r\nhello\r\n0\r\nX-Trailer: 1\r\n\r\n" in
  Alcotest.(check string)
    "body" "hello"
    (ok_protocol (Protocol.read_body src chunked_head))

let test_malformed_chunk_terminator () =
  let src = source "5\r\nhelloXX" in
  match Protocol.read_body src chunked_head with
  | Error (Protocol.Malformed "malformed chunk terminator") -> ()
  | _ -> Alcotest.fail "expected malformed chunk terminator"

let test_truncated_chunk () =
  let src = source "10\r\n{\"type\":" in
  match Protocol.read_body src chunked_head with
  | Error (Protocol.Malformed _) -> ()
  | _ -> Alcotest.fail "expected malformed"

let test_sized_zero () =
  let head = { Protocol.status = 200; headers = [ ("content-length", "0") ] } in
  Alcotest.(check string)
    "empty" ""
    (ok_protocol (Protocol.read_body (source "") head))

let test_until_close () =
  let head = { Protocol.status = 200; headers = [] } in
  Alcotest.(check string)
    "all" "{\"type\":\"idle\",\"sinceMs\":1}\n"
    (ok_protocol
       (Protocol.read_body (source "{\"type\":\"idle\",\"sinceMs\":1}\n") head))

let test_framer () =
  let f = Protocol.framer () in
  Alcotest.(check (list string))
    "lines" [ "{\"a\":1}" ]
    (ok_protocol (Protocol.feed f "\n{\"a\":1}\n\n{\"b\":2}"));
  Alcotest.(check (option string)) "tail" (Some "{\"b\":2}") (Protocol.finish f)

let test_framer_cap () =
  let f = Protocol.framer ~cap:16 () in
  match Protocol.feed f (String.make 17 'x') with
  | Error Protocol.Line_too_long -> ()
  | _ -> Alcotest.fail "expected Line_too_long"

let test_no_response () =
  match Protocol.read_head (source "") with
  | Error Protocol.No_response -> ()
  | _ -> Alcotest.fail "expected No_response"

let test_conformance_events () =
  let fixtures =
    Yojson.Safe.from_string (conformance "events.json")
    |> Yojson.Safe.Util.to_assoc
  in
  Alcotest.(check int) "count" 22 (List.length fixtures);
  let decoded =
    List.map
      (fun (name, json) ->
        ( name,
          get
            (Types.decode Types.event_of_json json
            |> Result.map_error (fun m ->
                   Types.Error.make ~retryable:false "TEST" (name ^ ": " ^ m)))
        ))
      fixtures
  in
  (match List.assoc "done-tool_use" decoded with
  | Types.Done r ->
      Alcotest.(check string) "status" "tool_use" r.status;
      Alcotest.(check int) "tool calls" 1 (List.length r.tool_calls)
  | _ -> Alcotest.fail "done-tool_use");
  (match List.assoc "error-no-type" decoded with
  | Types.Failed e -> Alcotest.check err_kind "no type" None e.kind
  | _ -> Alcotest.fail "error-no-type");
  match List.assoc "done-completed-with-thinking" decoded with
  | Types.Done r -> Alcotest.(check bool) "thinking" true (r.thinking_tokens > 0)
  | _ -> Alcotest.fail "done-completed-with-thinking"

(* ---------- client ---------- *)

let events stream =
  let acc = ref [] in
  iter stream (fun item -> acc := item :: !acc);
  List.rev !acc

let test_call_streams () =
  let c, log, closed = client (fixture "call-200-stream.raw") in
  let stream = get (call c (envelope ())) in
  let items = events stream in
  Alcotest.(check int) "events" 5 (List.length items);
  (match List.nth items 4 with
  | Ok (Types.Done r) ->
      Alcotest.(check (option string))
        "output" (Some "The sky is blue") r.output
  | _ -> Alcotest.fail "last");
  Alcotest.(check bool) "closed" true !closed;
  match !log with
  | [ r ] ->
      Alcotest.(check string) "meth" "POST" r.meth;
      Alcotest.(check string) "path" "/v1/call" r.path;
      Alcotest.(check string) "socket" "/tmp/data.sock" r.socket;
      let sent = Yojson.Safe.from_string (Option.get r.body) in
      Alcotest.(check string)
        "model" "local/llama3.1-8b"
        Yojson.Safe.Util.(member "model" sent |> to_string);
      Alcotest.(check int)
        "budget" 4
        Yojson.Safe.Util.(member "outputBudget" sent |> to_int)
  | _ -> Alcotest.fail "one request"

let test_collect () =
  let c, _, _ = client (fixture "call-200-stream.raw") in
  let r = get (collect c (envelope ())) in
  Alcotest.(check int) "output tokens" 4 r.output_tokens;
  Alcotest.(check string) "status" "incomplete" r.status

let test_collect_error_event () =
  let c, _, _ = client (fixture "call-200-error-event.raw") in
  Alcotest.check err_kind "kind" (Some "SESSION_UNKNOWN_MODEL")
    (kind_of (get_err (collect c (envelope ()))))

let test_rejection () =
  let c, _, _ = client (fixture "call-400-invalid-envelope.raw") in
  let e = get_err (call c (envelope ())) in
  Alcotest.check err_kind "kind" (Some "PROTOCOL_INVALID_ENVELOPE") e.kind;
  Alcotest.(check bool) "retryable" false e.retryable

let test_non_json_rejection () =
  let c, _, _ =
    client "HTTP/1.1 503 Service Unavailable\r\ncontent-length: 4\r\n\r\nbusy"
  in
  let e = get_err (collect c (envelope ())) in
  Alcotest.check err_kind "kind" (Some "PROTOCOL_HTTP_ERROR") e.kind;
  Alcotest.(check bool) "retryable" true e.retryable

let test_non_event_line () =
  let c, _, closed =
    client
      "HTTP/1.1 200 OK\r\n\
       content-type: application/x-ndjson\r\n\
       \r\n\
       {\"hello\":\"world\"}\n"
  in
  let e = get_err (collect c (envelope ())) in
  Alcotest.check err_kind "kind" (Some "PROTOCOL_INVALID_EVENT") e.kind;
  Alcotest.(check bool) "closed" true !closed

let test_truncated_chunked_body () =
  let c, _, _ =
    client
      "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n10\r\n{\"type\":"
  in
  Alcotest.check err_kind "kind" (Some "PROTOCOL_HTTP_ERROR")
    (kind_of (get_err (collect c (envelope ()))))

let test_close_cancels () =
  let c, _, closed = client (fixture "call-200-stream.raw") in
  let stream = get (call c (envelope ())) in
  (match next stream with
  | Some (Ok (Types.Delta _)) -> ()
  | _ -> Alcotest.fail "first delta");
  close stream;
  Alcotest.(check bool) "closed" true !closed;
  Alcotest.(check bool) "exhausted" true (next stream = None)

let test_empty_response () =
  let c, _, _ = client "" in
  let e = get_err (collect c (envelope ())) in
  Alcotest.check err_kind "kind" (Some "NET_ERROR") e.kind;
  Alcotest.(check bool) "retryable" true e.retryable

let test_image () =
  let body =
    "{\"status\":\"completed\",\"images\":[{\"mimeType\":\"image/png\",\"url\":\"https://cdn.example/abc.png\"}],\"seed\":42,\"timestamps\":{\"start\":\"1\",\"first\":\"3\",\"end\":\"3\"}}"
  in
  let c, log, _ = client (json_response body) in
  let r = get (image c (`Assoc [])) in
  Alcotest.(check int) "images" 1 (List.length r.images);
  Alcotest.(check (option string))
    "url" (Some "https://cdn.example/abc.png") (List.hd r.images).url;
  Alcotest.(check (option int)) "seed" (Some 42) r.seed;
  Alcotest.(check string) "path" "/v1/image" (List.hd !log).path

let test_image_malformed () =
  let c, _, _ = client (json_response "{\"status\":\"completed\"}") in
  Alcotest.check err_kind "kind" (Some "PROTOCOL_INVALID_EVENT")
    (kind_of (get_err (image c (`Assoc []))))

let test_transcription () =
  let body =
    "{\"status\":\"completed\",\"text\":\"Bonjour tout le \
     monde.\",\"language\":\"fr\",\"durationSeconds\":12.5,\"cost\":0.0000834,\"timestamps\":{\"start\":\"1\",\"first\":\"3\",\"end\":\"3\"}}"
  in
  let c, log, _ = client (json_response body) in
  let r = get (transcription c (`Assoc [])) in
  Alcotest.(check string) "text" "Bonjour tout le monde." r.text;
  Alcotest.(check (option (float 0.))) "duration" (Some 12.5) r.duration_seconds;
  Alcotest.(check string) "path" "/v1/transcription" (List.hd !log).path

let test_health () =
  let c, log, _ = client (fixture "health-200.raw") in
  Alcotest.(check string) "ok" "ok" (get (health c)).status;
  let r = List.hd !log in
  Alcotest.(check string) "meth" "GET" r.meth;
  Alcotest.(check string) "socket" "/tmp/admin.sock" r.socket;
  Alcotest.(check bool) "no body" true (r.body = None)

let test_health_without_admin () =
  let transport ~socket:_ ~meth:_ ~path:_ ~body:_ = Ok (source "") in
  let c = connect ~transport "/tmp/data.sock" in
  Alcotest.check err_kind "kind" (Some "CONFIGURATION_MISSING")
    (kind_of (get_err (health c)))

let test_envelope_json () =
  let json =
    Envelope.make ~model:"openai/gpt-5-mini" ~prompt:"hi"
    |> Envelope.call_id "c" |> Envelope.key "sk" |> Envelope.output_budget 20
    |> Envelope.with_field "outputType" (`String "json")
    |> Envelope.to_json |> Yojson.Safe.to_string
  in
  Alcotest.(check string)
    "json"
    "{\"callId\":\"c\",\"authId\":\"local\",\"auth\":{\"key\":\"sk\"},\"model\":\"openai/gpt-5-mini\",\"prompt\":\"hi\",\"outputBudget\":20,\"outputType\":\"json\"}"
    json

(* ---------- live (gated on MOHDEL_GATE_SOCKET) ---------- *)

let live () =
  Option.map
    (fun socket ->
      let admin_socket = Sys.getenv_opt "MOHDEL_GATE_ADMIN_SOCKET" in
      ( connect ?admin_socket socket,
        Option.value
          (Sys.getenv_opt "MOHDEL_LIVE_MODEL")
          ~default:"local/llama3.1-8b" ))
    (Sys.getenv_opt "MOHDEL_GATE_SOCKET")

let live_envelope model prompt budget =
  Envelope.make ~model ~prompt
  |> Envelope.auth_id "ocaml-live"
  |> Envelope.key (Option.value (Sys.getenv_opt "MOHDEL_LIVE_KEY") ~default:"")
  |> Envelope.output_budget budget
  |> Envelope.to_json

let test_live_stream () =
  match live () with
  | None -> ()
  | Some (c, model) ->
      let stream =
        get (call c (live_envelope model "Say the single word \"hi\"." 20))
      in
      let deltas = ref 0 and result = ref None in
      iter stream (function
        | Ok (Types.Delta _) -> incr deltas
        | Ok (Types.Done r) -> result := Some r
        | Ok (Types.Failed e) -> Alcotest.fail ("error event: " ^ e.message)
        | Ok (Types.Idle _) -> ()
        | Error e -> Alcotest.fail e.message);
      Alcotest.(check bool) "deltas" true (!deltas > 0);
      let r = Option.get !result in
      Alcotest.(check string) "completed" "completed" r.status;
      Alcotest.(check bool)
        "tokens" true
        (r.input_tokens > 0 && r.output_tokens > 0)

let test_live_budget () =
  match live () with
  | None -> ()
  | Some (c, model) ->
      let r =
        get
          (collect c
             (live_envelope model "Write a detailed essay about tigers." 1))
      in
      Alcotest.(check string) "incomplete" "incomplete" r.status;
      Alcotest.(check (option string))
        "warning" (Some "insufficientOutputBudget") r.warning

let test_live_close_then_next () =
  match live () with
  | None -> ()
  | Some (c, model) ->
      let stream =
        get
          (call c
             (live_envelope model
                "Count slowly from 1 to 100, one number per line." 200))
      in
      (match next stream with
      | Some (Ok (Types.Delta _)) -> ()
      | _ -> Alcotest.fail "first delta");
      close stream;
      Alcotest.(check string)
        "completed" "completed"
        (get (collect c (live_envelope model "Say the single word \"hi\"." 20)))
          .status

let test_live_health () =
  match (live (), Sys.getenv_opt "MOHDEL_GATE_ADMIN_SOCKET") with
  | Some (c, _), Some _ ->
      Alcotest.(check string) "ok" "ok" (get (health c)).status
  | _ -> ()

let () =
  let case name f = Alcotest.test_case name `Quick f in
  Alcotest.run "mohdel"
    [
      ( "protocol",
        [
          case "request bytes" test_request;
          case "200 chunked stream fixture" test_stream_fixture;
          case "200 error-event fixture" test_error_event_fixture;
          case "400 fixture" test_rejection_fixture;
          case "health fixture" test_health_fixture;
          case "chunk extension and trailer" test_chunk_extension_and_trailer;
          case "malformed chunk terminator" test_malformed_chunk_terminator;
          case "truncated chunk" test_truncated_chunk;
          case "sized zero body" test_sized_zero;
          case "body until close" test_until_close;
          case "framer blank lines and tail" test_framer;
          case "framer line cap" test_framer_cap;
          case "empty response" test_no_response;
          case "conformance events decode" test_conformance_events;
        ] );
      ( "client",
        [
          case "call streams events and sends the envelope" test_call_streams;
          case "collect returns the done result" test_collect;
          case "collect raises the error event" test_collect_error_event;
          case "non-200 is the gate TypedError" test_rejection;
          case "non-JSON non-200 is PROTOCOL_HTTP_ERROR" test_non_json_rejection;
          case "non-event line is PROTOCOL_INVALID_EVENT" test_non_event_line;
          case "truncated chunked body" test_truncated_chunked_body;
          case "close cancels" test_close_cancels;
          case "empty response is NET_ERROR" test_empty_response;
          case "image" test_image;
          case "image malformed" test_image_malformed;
          case "transcription" test_transcription;
          case "health" test_health;
          case "health without admin socket" test_health_without_admin;
          case "envelope to_json" test_envelope_json;
        ] );
      ( "live",
        [
          case "stream" test_live_stream;
          case "budget incomplete" test_live_budget;
          case "close then next call" test_live_close_then_next;
          case "health" test_live_health;
        ] );
    ]
