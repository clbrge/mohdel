--- mohdel client for Lua: talks to a thin-gate over its unix socket.
--
--   local mohdel = require('mohdel')
--   local c = mohdel.connect{ socket = '/tmp/mohdel-data.sock' }
--   for ev in c:call(envelope):events() do ... end
--
-- Transports: 'luasocket' (default) or 'curl' (no compiled
-- dependencies), or any table with `request(socket, method, path, body)`
-- returning a source. JSON: `dkjson` by default; pass `json = vim.json`
-- or any `{ encode, decode }` pair.
local protocol = require('mohdel.protocol')

local mohdel = {}

local Client = {}
Client.__index = Client

local Stream = {}
Stream.__index = Stream

local function make_decode(json)
  return function(text)
    local ok, value, _, err = pcall(json.decode, text)
    if not ok then
      error(protocol.typed_error('PROTOCOL_INVALID_EVENT', 'invalid JSON from thin-gate',
        { detail = tostring(value) }), 0)
    end
    if value == nil and err ~= nil then
      error(protocol.typed_error('PROTOCOL_INVALID_EVENT', 'invalid JSON from thin-gate',
        { detail = tostring(err) }), 0)
    end
    return value
  end
end

local function resolve_transport(transport)
  if transport == nil or transport == 'luasocket' then
    return require('mohdel.transport.luasocket')
  elseif transport == 'curl' then
    return require('mohdel.transport.curl')
  elseif type(transport) == 'table' and type(transport.request) == 'function' then
    return transport
  end
  error("mohdel.connect: transport must be 'luasocket', 'curl', or a table with request()", 3)
end

function mohdel.connect(opts)
  if type(opts) ~= 'table' or type(opts.socket) ~= 'string' then
    error('mohdel.connect: opts.socket (data-plane unix socket path) is required', 2)
  end
  local json = opts.json or require('dkjson')
  return setmetatable({
    socket = opts.socket,
    admin_socket = opts.admin_socket,
    transport = resolve_transport(opts.transport),
    json = json,
    decode = make_decode(json),
  }, Client)
end

mohdel.is_error = protocol.is_error
mohdel.is_event = protocol.is_event

local function open(self, method, path, body, socket_path)
  local src = self.transport.request(socket_path or self.socket, method, path, body)
  local ok, status, headers = pcall(protocol.read_head, src)
  if not ok then
    src:close()
    error(status, 0)
  end
  return src, status, headers
end

local function read_json(self, method, path, envelope, socket_path)
  local body = envelope and self.json.encode(envelope) or nil
  local src, status, headers = open(self, method, path, body, socket_path)
  local ok, text = pcall(protocol.read_body, src, headers)
  src:close()
  if not ok then error(text, 0) end
  if status ~= 200 then
    error(protocol.error_from_body(text, status, self.decode), 0)
  end
  local ok2, parsed = pcall(self.decode, text)
  if not ok2 then
    error(protocol.typed_error('PROTOCOL_INVALID_EVENT', 'thin-gate returned a non-JSON response',
      { detail = protocol.is_error(parsed) and parsed.detail or tostring(parsed) }), 0)
  end
  return parsed
end

function Client:call(envelope)
  local src, status, headers = open(self, 'POST', protocol.PATHS.call, self.json.encode(envelope))
  if status ~= 200 then
    local ok, text = pcall(protocol.read_body, src, headers)
    src:close()
    if not ok then error(text, 0) end
    error(protocol.error_from_body(text, status, self.decode), 0)
  end
  return setmetatable({
    _src = src,
    _chunks = protocol.body_chunks(src, headers),
    _framer = protocol.ndjson_framer(self.decode),
    _queue = {},
    _next = 1,
    _finished = false,
    _closed = false,
  }, Stream)
end

function Client:image(envelope)
  local result = read_json(self, 'POST', protocol.PATHS.image, envelope)
  if type(result) ~= 'table' or result.status ~= 'completed' or type(result.images) ~= 'table' then
    error(protocol.typed_error('PROTOCOL_INVALID_EVENT', 'thin-gate returned a malformed ImageResult'), 0)
  end
  return result
end

function Client:transcription(envelope)
  local result = read_json(self, 'POST', protocol.PATHS.transcription, envelope)
  if type(result) ~= 'table' or result.status ~= 'completed' or type(result.text) ~= 'string' then
    error(protocol.typed_error('PROTOCOL_INVALID_EVENT', 'thin-gate returned a malformed TranscriptionResult'), 0)
  end
  return result
end

function Client:health()
  if type(self.admin_socket) ~= 'string' then
    error('mohdel: health() needs opts.admin_socket (admin-plane unix socket path)', 2)
  end
  return read_json(self, 'GET', protocol.PATHS.health, nil, self.admin_socket)
end

local function fail(stream, err)
  stream:close()
  error(err, 0)
end

local function check(stream, obj)
  if not protocol.is_event(obj) then
    fail(stream, protocol.typed_error('PROTOCOL_INVALID_EVENT', 'received a non-Event object from thin-gate'))
  end
  return obj
end

--- Next event, or nil once the stream is exhausted. A `done` or
-- `error` event is the last one the gate sends.
function Stream:next()
  if self._finished then return nil end
  while self._next > #self._queue do
    self._queue, self._next = {}, 1
    local ok, chunk = pcall(self._chunks)
    if not ok then fail(self, chunk) end
    if chunk == nil then
      local ok2, tail = pcall(self._framer.finish)
      if not ok2 then fail(self, tail) end
      self._finished = true
      self:close()
      if tail ~= nil then return check(self, tail) end
      return nil
    end
    local ok3, objects = pcall(self._framer.feed, chunk)
    if not ok3 then fail(self, objects) end
    self._queue = objects
  end
  local obj = self._queue[self._next]
  self._next = self._next + 1
  return check(self, obj)
end

function Stream:events()
  return function() return self:next() end
end

--- Closes the socket. Closing before the terminal event is how a
-- caller cancels: the gate infers cancel from the connection close.
function Stream:close()
  self._finished = true
  if not self._closed then
    self._closed = true
    self._src:close()
  end
end

--- Drains the stream. Returns the `done` result (with `output`
-- already assembled from the deltas by the gate); raises the
-- `error` event's TypedError.
function Stream:collect()
  local result
  for ev in self:events() do
    if ev.type == 'done' then
      result = ev.result
    elseif ev.type == 'error' then
      fail(self, ev.error)
    end
  end
  if result == nil then
    error(protocol.typed_error('PROTOCOL_INVALID_EVENT', 'stream ended without a terminal event'), 0)
  end
  return result
end

return mohdel
