--- Transport that shells out to `curl --unix-socket`. No compiled
-- dependencies; streaming through the pipe.
--
-- The request body (which carries `auth.key`) is handed to curl
-- through a temporary file. Lua 5.4's `os.tmpname` creates it with
-- mode 0600; Lua 5.1/LuaJIT create it with the process umask, so on a
-- shared host prefer the luasocket transport for keyed calls.
local protocol = require('mohdel.protocol')

local M = {}

local function quote(s)
  return "'" .. s:gsub("'", "'\\''") .. "'"
end

function M.request(socket_path, method, path, body)
  local args = {
    'curl', '-sS', '--raw', '-i', '-N',
    '--unix-socket', quote(socket_path),
    '-X', method,
    '-H', quote('Host: localhost'),
  }
  local tmp
  if body then
    tmp = os.tmpname()
    local f = assert(io.open(tmp, 'wb'))
    f:write(body)
    f:close()
    args[#args + 1] = '-H'
    args[#args + 1] = quote('Content-Type: application/json')
    args[#args + 1] = '--data-binary'
    args[#args + 1] = quote('@' .. tmp)
  end
  args[#args + 1] = quote('http://localhost' .. path)

  local pipe = io.popen(table.concat(args, ' ') .. ' 2>/dev/null', 'r')
  if not pipe then
    error(protocol.typed_error('NET_ERROR', 'could not start curl', { retryable = true }), 0)
  end

  local src = {}

  function src:read_line()
    local line = pipe:read('*l')
    if line == nil then return nil end
    return (line:gsub('\r$', ''))
  end

  function src:read(n)
    local data = pipe:read(n)
    if data == nil or data == '' then return nil end
    return data
  end

  function src:close()
    pipe:close()
    if tmp then os.remove(tmp) end
  end

  return src
end

return M
