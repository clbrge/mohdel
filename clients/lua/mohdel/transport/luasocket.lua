--- Transport over LuaSocket's `socket.unix` stream sockets.
local unix = require('socket.unix')
local protocol = require('mohdel.protocol')

local M = {}

local function fail(err)
  error(protocol.typed_error('NET_ERROR', 'thin-gate socket error',
    { detail = tostring(err), retryable = true }), 0)
end

function M.request(socket_path, method, path, body)
  local sock = unix.stream()
  local ok, err = sock:connect(socket_path)
  if not ok then fail(err) end
  local sent, send_err = sock:send(protocol.request(method, path, body))
  if not sent then fail(send_err) end

  local src = {}

  function src:read_line()
    local line, rerr = sock:receive('*l')
    if line ~= nil then return line end
    if rerr == 'closed' then return nil end
    fail(rerr)
  end

  function src:read(n)
    local data, rerr, partial = sock:receive(n)
    if data ~= nil then return data end
    if rerr == 'closed' then
      if partial ~= nil and #partial > 0 then return partial end
      return nil
    end
    fail(rerr)
  end

  function src:close()
    sock:close()
  end

  return src
end

return M
