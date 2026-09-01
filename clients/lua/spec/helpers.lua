local H = {}

local here = debug.getinfo(1, 'S').source:match('^@(.*)/[^/]*$') or '.'

function H.read_file(rel)
  local f = assert(io.open(here .. '/' .. rel, 'rb'))
  local s = f:read('*a')
  f:close()
  return s
end

function H.fixture(name)
  return H.read_file('../../../test/conformance/gate/' .. name)
end

function H.conformance(name)
  return H.read_file('../../../test/conformance/' .. name)
end

--- Source over a byte string, honouring the protocol's source contract
-- (`read(n)` is exact unless EOF).
function H.source(bytes)
  local pos = 1
  local src = { closed = false }
  function src:read_line()
    if pos > #bytes then return nil end
    local nl = bytes:find('\n', pos, true)
    local line
    if nl then
      line = bytes:sub(pos, nl - 1)
      pos = nl + 1
    else
      line = bytes:sub(pos)
      pos = #bytes + 1
    end
    return (line:gsub('\r$', ''))
  end
  function src:read(n)
    if pos > #bytes then return nil end
    local data = bytes:sub(pos, pos + n - 1)
    pos = pos + #data
    return data
  end
  function src:close() self.closed = true end
  return src
end

--- Transport that answers every request with the given bytes and
-- records what was sent.
function H.transport(bytes)
  local t = { requests = {} }
  function t.request(socket_path, method, path, body)
    t.requests[#t.requests + 1] = { socket = socket_path, method = method, path = path, body = body }
    t.last_source = H.source(bytes)
    return t.last_source
  end
  return t
end

return H
