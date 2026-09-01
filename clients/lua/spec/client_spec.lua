local mohdel = require('mohdel')
local json = require('dkjson')
local H = require('spec.helpers')

local ENVELOPE = {
  callId = 'c-1', authId = 'u-1', auth = { key = '' },
  model = 'local/llama3.1-8b', prompt = 'why is the sky blue', outputBudget = 4,
}

local function client(bytes, extra)
  local t = H.transport(bytes)
  local opts = { socket = '/tmp/data.sock', admin_socket = '/tmp/admin.sock', transport = t }
  if extra then for k, v in pairs(extra) do opts[k] = v end end
  return mohdel.connect(opts), t
end

describe('connect', function()
  it('requires a socket path', function()
    assert.has_error(function() mohdel.connect({}) end)
  end)

  it('rejects an unknown transport name', function()
    assert.has_error(function() mohdel.connect({ socket = '/s', transport = 'carrier-pigeon' }) end)
  end)

  it('accepts a transport table', function()
    local c = client(H.fixture('health-200.raw'))
    assert.is_not_nil(c)
  end)
end)

describe('call', function()
  it('sends the envelope as JSON to /v1/call and streams events', function()
    local c, t = client(H.fixture('call-200-stream.raw'))
    local events = {}
    for ev in c:call(ENVELOPE):events() do events[#events + 1] = ev end
    assert.are.equal(1, #t.requests)
    assert.are.equal('POST', t.requests[1].method)
    assert.are.equal('/v1/call', t.requests[1].path)
    assert.are.equal('/tmp/data.sock', t.requests[1].socket)
    assert.are.same(ENVELOPE, json.decode(t.requests[1].body))
    assert.are.equal(5, #events)
    assert.are.equal('done', events[5].type)
    assert.is_true(t.last_source.closed)
  end)

  it('collect() returns the done result', function()
    local c = client(H.fixture('call-200-stream.raw'))
    local result = c:call(ENVELOPE):collect()
    assert.are.equal('The sky is blue', result.output)
    assert.are.equal(4, result.outputTokens)
  end)

  it('collect() raises the error event as a TypedError', function()
    local c = client(H.fixture('call-200-error-event.raw'))
    local ok, err = pcall(function() return c:call(ENVELOPE):collect() end)
    assert.is_false(ok)
    assert.is_true(mohdel.is_error(err))
    assert.are.equal('SESSION_UNKNOWN_MODEL', err.type)
  end)

  it('a non-200 response raises the gate TypedError before any event', function()
    local c = client(H.fixture('call-400-invalid-envelope.raw'))
    local ok, err = pcall(function() return c:call(ENVELOPE) end)
    assert.is_false(ok)
    assert.are.equal('PROTOCOL_INVALID_ENVELOPE', err.type)
  end)

  it('a non-event line raises PROTOCOL_INVALID_EVENT and closes the socket', function()
    local c, t = client('HTTP/1.1 200 OK\r\ncontent-type: application/x-ndjson\r\n\r\n{"hello":"world"}\n')
    local stream = c:call(ENVELOPE)
    local ok, err = pcall(stream.next, stream)
    assert.is_false(ok)
    assert.are.equal('PROTOCOL_INVALID_EVENT', err.type)
    assert.is_true(t.last_source.closed)
  end)

  it('close() before the terminal event closes the socket (cancel)', function()
    local c, t = client(H.fixture('call-200-stream.raw'))
    local stream = c:call(ENVELOPE)
    assert.are.equal('delta', stream:next().type)
    stream:close()
    assert.is_true(t.last_source.closed)
    assert.is_nil(stream:next())
  end)
end)

describe('image', function()
  local fixtures = json.decode(H.conformance('images.json'))

  local function response(result)
    local body = json.encode(result)
    return 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ' .. #body .. '\r\n\r\n' .. body
  end

  it('returns the ImageResult and posts to /v1/image', function()
    local c, t = client(response(fixtures['result-url-only']))
    local result = c:image(fixtures['envelope-minimal'])
    assert.are.equal('/v1/image', t.requests[1].path)
    assert.are.same(fixtures['result-url-only'], result)
  end)

  it('a malformed ImageResult raises PROTOCOL_INVALID_EVENT', function()
    local c = client(response({ status = 'completed' }))
    local ok, err = pcall(c.image, c, fixtures['envelope-minimal'])
    assert.is_false(ok)
    assert.are.equal('PROTOCOL_INVALID_EVENT', err.type)
  end)
end)

describe('transcription', function()
  local fixtures = json.decode(H.conformance('transcriptions.json'))

  it('returns the TranscriptionResult and posts to /v1/transcription', function()
    local body = json.encode(fixtures['result-duration-billed'])
    local c, t = client('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n' ..
      'content-length: ' .. #body .. '\r\n\r\n' .. body)
    local result = c:transcription(fixtures['envelope-minimal'])
    assert.are.equal('/v1/transcription', t.requests[1].path)
    assert.are.equal('Bonjour tout le monde.', result.text)
  end)
end)

describe('health', function()
  it('GETs /v1/health on the admin socket', function()
    local c, t = client(H.fixture('health-200.raw'))
    assert.are.equal('ok', c:health().status)
    assert.are.equal('GET', t.requests[1].method)
    assert.are.equal('/tmp/admin.sock', t.requests[1].socket)
    assert.is_nil(t.requests[1].body)
  end)

  it('needs an admin socket', function()
    local c = mohdel.connect({ socket = '/s', transport = H.transport('') })
    assert.has_error(function() c:health() end)
  end)
end)

describe('json codec injection', function()
  it('uses the supplied encode/decode pair', function()
    local calls = { encode = 0, decode = 0 }
    local codec = {
      encode = function(v) calls.encode = calls.encode + 1; return json.encode(v) end,
      decode = function(s) calls.decode = calls.decode + 1; return json.decode(s) end,
    }
    local c = client(H.fixture('health-200.raw'), { json = codec })
    c:health()
    assert.are.equal(1, calls.decode)
  end)
end)
