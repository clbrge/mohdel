# mohdel — Lua client

Talks to a running [mohdel](../../README.md) thin-gate over its unix socket:
chat completions with streaming, tool calls and vision, image generation,
speech to text, per-call USD cost. Lua 5.1+ and LuaJIT.

## Install

```sh
cd clients/lua && luarocks make
```

Dependencies: `dkjson`, `luasocket` (≥ 3.0). The `curl` transport needs
neither luasocket nor a compiler, only `curl` on `PATH`.

## Use

```lua
local mohdel = require('mohdel')

local c = mohdel.connect{
  socket = '/tmp/mohdel-data.sock',        -- data plane
  admin_socket = '/tmp/mohdel-admin.sock', -- optional, for health()
  -- transport = 'luasocket' (default) | 'curl' | { request = fn }
  -- json = vim.json                        -- any { encode, decode } pair; dkjson by default
}

local envelope = {
  callId = 'c-1', authId = 'u-1', auth = { key = os.getenv('ANTHROPIC_API_SK') },
  model = 'anthropic/claude-haiku-4-5', prompt = 'Hello',
}

-- stream
local stream = c:call(envelope)
for ev in stream:events() do
  if ev.type == 'delta' then io.write(ev.delta.delta)
  elseif ev.type == 'done' then print('\n$' .. ev.result.cost)
  elseif ev.type == 'error' then print(ev.error.type, ev.error.message) end
end

-- or drain
local result = c:call(envelope):collect()   -- done.result; raises the error event
print(result.output, result.inputTokens, result.outputTokens, result.cost)

-- cancel: close before the terminal event
local s = c:call(envelope)
print(s:next().type)  -- 'delta'
s:close()

c:image(envelope)          -- ImageResult
c:transcription(envelope)  -- TranscriptionResult
c:health()                 -- { status = 'ok', version = ..., uptime_ms = ... }
```

Envelope, event and result shapes are the ones in
[PROTOCOL.md](../../PROTOCOL.md) (§3.1, §4, §10), camelCase.

## Errors

Errors are raised as the gate's `TypedError` table —
`{ type, message, detail?, severity, retryable }` — so `pcall` sites branch on
`err.type`; `mohdel.is_error(err)` tells them apart from string errors.
Client-side tags: `NET_ERROR` (socket), `PROTOCOL_HTTP_ERROR` (non-JSON
non-200, retryable for 5xx), `PROTOCOL_INVALID_EVENT` (non-event line,
over-long line, malformed result).

## Tests

```sh
luarocks install busted luacheck
luacheck . && busted
```

`spec/live_spec.lua` runs only with `MOHDEL_GATE_SOCKET` set (optionally
`MOHDEL_GATE_ADMIN_SOCKET`, `MOHDEL_LIVE_MODEL`, `MOHDEL_LUA_TRANSPORT=curl`,
`MOHDEL_LIVE_KEY`).
