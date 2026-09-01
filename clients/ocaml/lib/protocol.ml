(* Wire layer for the thin-gate HTTP surface: request bytes, response
   head, chunked bodies, NDJSON framing. Pull-style over a [source]. *)

let max_line_bytes = 16 * 1024 * 1024
let call_path = "/v1/call"
let image_path = "/v1/image"
let transcription_path = "/v1/transcription"
let health_path = "/v1/health"

type error =
  | No_response  (** The peer closed before sending a response head. *)
  | Malformed of string
      (** Bytes that do not form a valid HTTP/1.1 response. *)
  | Line_too_long
      (** One NDJSON line exceeded [max_line_bytes] without a newline. *)

type source = {
  read_line : unit -> string option;
  read : int -> string option;
  close : unit -> unit;
}
(** [read_line] is [None] at EOF; [read n] returns exactly [n] bytes, fewer only
    at EOF, [None] when nothing is left. *)

type head = { status : int; headers : (string * string) list }

let header head name = List.assoc_opt name head.headers

let request ~meth ~path ?body () =
  let base =
    Printf.sprintf "%s %s HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n"
      meth path
  in
  match body with
  | Some b ->
      Printf.sprintf
        "%sContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s" base
        (String.length b) b
  | None -> base ^ "\r\n"

let split_once s ch =
  match String.index_opt s ch with
  | None -> None
  | Some i ->
      Some (String.sub s 0 i, String.sub s (i + 1) (String.length s - i - 1))

let parse_status line =
  match String.split_on_char ' ' line with
  | ("HTTP/1.1" | "HTTP/1.0") :: code :: _ -> (
      match int_of_string_opt code with
      | Some status -> Ok status
      | None -> Error (Malformed ("malformed status line: " ^ line)))
  | _ -> Error (Malformed ("malformed status line: " ^ line))

let read_head src =
  match src.read_line () with
  | None -> Error No_response
  | Some status_line -> (
      match parse_status status_line with
      | Error e -> Error e
      | Ok status ->
          let rec headers acc =
            match src.read_line () with
            | None ->
                Error (Malformed "connection closed inside the response head")
            | Some "" -> Ok (List.rev acc)
            | Some line ->
                let acc =
                  match split_once line ':' with
                  | Some (k, v) ->
                      (String.lowercase_ascii (String.trim k), String.trim v)
                      :: acc
                  | None -> acc
                in
                headers acc
          in
          Result.map (fun headers -> { status; headers }) (headers []))

let read_exact src n what =
  match src.read n with
  | Some data when String.length data = n -> Ok data
  | _ -> Error (Malformed ("connection closed inside " ^ what))

let contains_ci haystack needle =
  let h = String.lowercase_ascii haystack in
  let n = String.length needle and l = String.length h in
  let rec go i = i + n <= l && (String.sub h i n = needle || go (i + 1)) in
  go 0

let parse_chunk_size line =
  let hex = match split_once line ';' with Some (h, _) -> h | None -> line in
  match int_of_string_opt ("0x" ^ String.trim hex) with
  | Some n -> Ok n
  | None -> Error (Malformed ("malformed chunk size: " ^ line))

(** Reader of body chunks: each call yields the next decoded piece, [Ok None]
    once the body is complete according to its framing. *)
let body_chunks src head : unit -> (string option, error) result =
  let chunked =
    match header head "transfer-encoding" with
    | Some te -> contains_ci te "chunked"
    | None -> false
  in
  if chunked then
    let finished = ref false in
    fun () ->
      if !finished then Ok None
      else
        match src.read_line () with
        | None -> Error (Malformed "connection closed inside the chunked body")
        | Some size_line -> (
            match parse_chunk_size size_line with
            | Error e -> Error e
            | Ok 0 ->
                let rec trailers () =
                  match src.read_line () with
                  | None | Some "" -> ()
                  | Some _ -> trailers ()
                in
                trailers ();
                finished := true;
                Ok None
            | Ok size -> (
                match read_exact src size "a chunk" with
                | Error e -> Error e
                | Ok data -> (
                    match read_exact src 2 "a chunk terminator" with
                    | Ok "\r\n" -> Ok (Some data)
                    | Ok _ -> Error (Malformed "malformed chunk terminator")
                    | Error e -> Error e)))
  else
    match Option.bind (header head "content-length") int_of_string_opt with
    | Some length ->
        let sent = ref false in
        fun () ->
          if !sent || length = 0 then Ok None
          else (
            sent := true;
            Result.map Option.some (read_exact src length "the body"))
    | None -> (
        let eof = ref false in
        fun () ->
          if !eof then Ok None
          else
            match src.read 8192 with
            | None ->
                eof := true;
                Ok None
            | some -> Ok some)

let read_body src head =
  let next = body_chunks src head in
  let out = Buffer.create 1024 in
  let rec go () =
    match next () with
    | Error e -> Error e
    | Ok None -> Ok (Buffer.contents out)
    | Ok (Some data) ->
        Buffer.add_string out data;
        go ()
  in
  go ()

type framer = { mutable buf : string; cap : int }
(** Splits body bytes into NDJSON documents. ['\n'] is the only terminator;
    blank lines are skipped; the cap bounds an unterminated line in bytes. *)

let framer ?(cap = max_line_bytes) () = { buf = ""; cap }

let feed f bytes =
  let buf = f.buf ^ bytes in
  let rec split buf acc =
    match String.index_opt buf '\n' with
    | None -> (buf, List.rev acc)
    | Some i ->
        let line = String.trim (String.sub buf 0 i) in
        let rest = String.sub buf (i + 1) (String.length buf - i - 1) in
        split rest (if line = "" then acc else line :: acc)
  in
  let rest, lines = split buf [] in
  f.buf <- rest;
  if String.length rest > f.cap then Error Line_too_long else Ok lines

let finish f =
  let tail = String.trim f.buf in
  f.buf <- "";
  if tail = "" then None else Some tail
