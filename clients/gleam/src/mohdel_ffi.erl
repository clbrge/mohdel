-module(mohdel_ffi).
-export([connect/1, send/2, recv/1, close/1, call_id/0]).

reason(Reason) -> list_to_binary(io_lib:format("~p", [Reason])).

connect(Path) ->
    case gen_tcp:connect({local, Path}, 0, [binary, {active, false}, {packet, raw}]) of
        {ok, Sock} -> {ok, Sock};
        {error, Reason} -> {error, reason(Reason)}
    end.

send(Sock, Bin) ->
    case gen_tcp:send(Sock, Bin) of
        ok -> {ok, nil};
        {error, Reason} -> {error, reason(Reason)}
    end.

%% {ok, {some, Bytes}} | {ok, none} at EOF | {error, Reason}
recv(Sock) ->
    case gen_tcp:recv(Sock, 0, infinity) of
        {ok, Bin} -> {ok, {some, Bin}};
        {error, closed} -> {ok, none};
        {error, Reason} -> {error, reason(Reason)}
    end.

close(Sock) ->
    gen_tcp:close(Sock),
    nil.

call_id() ->
    Ts = integer_to_binary(erlang:system_time(millisecond)),
    N = integer_to_binary(erlang:unique_integer([positive])),
    <<"g_", Ts/binary, "_", N/binary>>.
