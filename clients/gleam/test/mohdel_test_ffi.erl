-module(mohdel_test_ffi).
-export([queue_new/1, queue_next/1, log_new/0, log_push/2, log_all/1]).

%% Replays a list of byte slices, one per recv, via the process dictionary.
queue_new(Slices) ->
    Ref = make_ref(),
    put(Ref, Slices),
    Ref.

queue_next(Ref) ->
    case get(Ref) of
        [] -> {ok, none};
        [H | T] -> put(Ref, T), {ok, {some, H}}
    end.

log_new() ->
    Ref = make_ref(),
    put(Ref, []),
    Ref.

log_push(Ref, Item) ->
    put(Ref, [Item | get(Ref)]),
    nil.

log_all(Ref) ->
    lists:reverse(get(Ref)).
