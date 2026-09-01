(* Byte transport to the gate. The default opens the unix socket with
   the stdlib [Unix] module; tests substitute a transport that replays
   bytes. *)

type t =
  socket:string ->
  meth:string ->
  path:string ->
  body:string option ->
  (Protocol.source, string) result

let strip_cr line =
  let n = String.length line in
  if n > 0 && line.[n - 1] = '\r' then String.sub line 0 (n - 1) else line

let source_of_channel ic : Protocol.source =
  let read n =
    let buf = Bytes.create n in
    let rec go off =
      if off = n then off
      else match input ic buf off (n - off) with 0 -> off | k -> go (off + k)
    in
    match go 0 with 0 -> None | got -> Some (Bytes.sub_string buf 0 got)
  in
  {
    read_line = (fun () -> Option.map strip_cr (In_channel.input_line ic));
    read;
    close = (fun () -> close_in_noerr ic);
  }

let unix_socket : t =
 fun ~socket ~meth ~path ~body ->
  let fd = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  try
    Unix.connect fd (Unix.ADDR_UNIX socket);
    let request = Protocol.request ~meth ~path ?body () in
    let rec send off =
      if off < String.length request then
        send
          (off
          + Unix.write_substring fd request off (String.length request - off))
    in
    send 0;
    Ok (source_of_channel (Unix.in_channel_of_descr fd))
  with Unix.Unix_error (e, fn, _) ->
    Unix.close fd;
    Error (Printf.sprintf "%s: %s" fn (Unix.error_message e))
