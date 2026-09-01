--- Wire layer for the thin-gate HTTP surface: request bytes, response
-- head, chunked bodies, NDJSON framing, event and error shapes.
-- Pure Lua 5.1+. No I/O and no JSON codec of its own: readers are
-- driven through a `source` — `:read_line()` (nil at EOF), `:read(n)`
-- (exactly n bytes; fewer only at EOF; nil when nothing is left) and
-- `:close()` — and decoding goes through an injected `decode` function.
local M = {}

M.MAX_LINE_BYTES = 16 * 1024 * 1024

M.PATHS = {
  call = '/v1/call',
  image = '/v1/image',
  transcription = '/v1/transcription',
  health = '/v1/health',
}

local EVENT_TYPES = { delta = true, idle = true, done = true, error = true }

local function trim(s)
  return (s:gsub('^%s+', ''):gsub('%s+$', ''))
end

function M.typed_error(type_, message, extra)
  local e = { type = type_, message = message, severity = 'error', retryable = false }
  if extra then
    for k, v in pairs(extra) do e[k] = v end
  end
  return e
end

function M.is_error(x)
  return type(x) == 'table' and type(x.type) == 'string' and type(x.message) == 'string'
end

function M.is_event(x)
  return type(x) == 'table' and EVENT_TYPES[x.type] == true
end

function M.request(method, path, body)
  local head = {
    method .. ' ' .. path .. ' HTTP/1.1',
    'Host: localhost',
    'Connection: close',
  }
  if body then
    head[#head + 1] = 'Content-Type: application/json'
    head[#head + 1] = 'Content-Length: ' .. #body
  end
  return table.concat(head, '\r\n') .. '\r\n\r\n' .. (body or '')
end

local function protocol_error(message, detail)
  return M.typed_error('PROTOCOL_HTTP_ERROR', message, detail and { detail = detail } or nil)
end

function M.read_head(src)
  local status_line = src:read_line()
  if status_line == nil then
    error(M.typed_error('NET_ERROR', 'no response from thin-gate', { retryable = true }), 0)
  end
  local status = tonumber(status_line:match('^HTTP/%d%.%d (%d%d%d)'))
  if not status then
    error(protocol_error('malformed status line from thin-gate', status_line), 0)
  end
  local headers = {}
  while true do
    local line = src:read_line()
    if line == nil then
      error(protocol_error('connection closed inside the response head'), 0)
    end
    if line == '' then break end
    local k, v = line:match('^([^:]+):%s*(.-)%s*$')
    if k then headers[k:lower()] = v end
  end
  return status, headers
end

local function read_exact(src, n, what)
  local data = src:read(n)
  if data == nil or #data ~= n then
    error(protocol_error('connection closed inside ' .. what), 0)
  end
  return data
end

--- Iterator over body byte chunks. Ends (returns nil) when the body
-- is complete according to its framing.
function M.body_chunks(src, headers)
  local te = headers['transfer-encoding']
  if te and te:lower():find('chunked', 1, true) then
    local finished = false
    return function()
      if finished then return nil end
      local size_line = src:read_line()
      if size_line == nil then
        error(protocol_error('connection closed inside the chunked body'), 0)
      end
      local size = tonumber(size_line:match('^(%x+)') or '', 16)
      if size == nil then
        error(protocol_error('malformed chunk size', size_line), 0)
      end
      if size == 0 then
        local line
        repeat line = src:read_line() until line == nil or line == ''
        finished = true
        return nil
      end
      local data = read_exact(src, size, 'a chunk')
      if read_exact(src, 2, 'a chunk terminator') ~= '\r\n' then
        error(protocol_error('malformed chunk terminator'), 0)
      end
      return data
    end
  end

  local length = tonumber(headers['content-length'])
  if length then
    local sent = false
    return function()
      if sent or length == 0 then return nil end
      sent = true
      return read_exact(src, length, 'the body')
    end
  end

  local eof = false
  return function()
    if eof then return nil end
    local data = src:read(8192)
    if data == nil then
      eof = true
      return nil
    end
    return data
  end
end

function M.read_body(src, headers)
  local parts = {}
  for chunk in M.body_chunks(src, headers) do
    parts[#parts + 1] = chunk
  end
  return table.concat(parts)
end

--- Splits a byte stream into NDJSON documents. `\n` (0x0A) is the only
-- line terminator; the cap bounds one unterminated line in bytes.
function M.ndjson_framer(decode, max_line_bytes)
  local cap = max_line_bytes or M.MAX_LINE_BYTES
  local buf = ''
  local framer = {}

  function framer.feed(bytes)
    buf = buf .. bytes
    local out = {}
    while true do
      local nl = buf:find('\n', 1, true)
      if not nl then break end
      local line = trim(buf:sub(1, nl - 1))
      buf = buf:sub(nl + 1)
      if line ~= '' then out[#out + 1] = decode(line) end
    end
    if #buf > cap then
      error(M.typed_error('PROTOCOL_INVALID_EVENT',
        'NDJSON line exceeds ' .. cap .. ' bytes without newline'), 0)
    end
    return out
  end

  function framer.finish()
    local tail = trim(buf)
    buf = ''
    if tail ~= '' then return decode(tail) end
    return nil
  end

  return framer
end

function M.error_from_body(body, status, decode)
  local ok, parsed = pcall(decode, body)
  if ok and type(parsed) == 'table' and type(parsed.type) == 'string' then
    return parsed
  end
  return M.typed_error('PROTOCOL_HTTP_ERROR', 'thin-gate returned HTTP ' .. status,
    { retryable = status >= 500 })
end

return M
