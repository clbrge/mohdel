(* Builder for a CallEnvelope (PROTOCOL.md §3.1). The common fields are
   typed; anything else goes in through [with_field]. Setters take the
   envelope last so they chain with [|>]. *)

type t = {
  call_id : string;
  auth_id : string;
  key : string;
  model : string;
  prompt : Yojson.Safe.t;
  output_budget : int option;
  output_effort : string option;
  identifier : string option;
  extra : (string * Yojson.Safe.t) list;
}

let counter = ref 0

let fresh_call_id () =
  incr counter;
  Printf.sprintf "o_%d_%d_%d"
    (int_of_float (Unix.gettimeofday () *. 1000.))
    (Unix.getpid ()) !counter

let make ~model ~prompt =
  {
    call_id = fresh_call_id ();
    auth_id = "local";
    key = "";
    model;
    prompt = `String prompt;
    output_budget = None;
    output_effort = None;
    identifier = None;
    extra = [];
  }

let key key t = { t with key }
let auth_id auth_id t = { t with auth_id }
let call_id call_id t = { t with call_id }

(** A structured prompt ([Message[]]), built as JSON. *)
let prompt_json prompt t = { t with prompt }

let output_budget n t = { t with output_budget = Some n }
let output_effort e t = { t with output_effort = Some e }
let identifier i t = { t with identifier = Some i }

(** Any other envelope field ([tools], [images], [outputType], ...). *)
let with_field name value t = { t with extra = t.extra @ [ (name, value) ] }

let to_json t : Yojson.Safe.t =
  let optional name to_json = function
    | Some v -> [ (name, to_json v) ]
    | None -> []
  in
  `Assoc
    ([
       ("callId", `String t.call_id);
       ("authId", `String t.auth_id);
       ("auth", `Assoc [ ("key", `String t.key) ]);
       ("model", `String t.model);
       ("prompt", t.prompt);
     ]
    @ optional "outputBudget" (fun n -> `Int n) t.output_budget
    @ optional "outputEffort" (fun s -> `String s) t.output_effort
    @ optional "identifier" (fun s -> `String s) t.identifier
    @ t.extra)
