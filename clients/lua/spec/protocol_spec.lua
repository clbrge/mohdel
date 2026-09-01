local protocol = require('mohdel.protocol')
local json = require('dkjson')
local H = require('spec.helpers')

local function decode(s)
  local v, _, err = json.decode(s)
  assert(v ~= nil or err == nil, err)
  return v
end

describe('request bytes', function()
  it('POST carries a JSON body with Content-Length and Connection: close', function()
    assert.are.equal(
      'POST /v1/call HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n' ..
      'Content-Type: application/json\r\nContent-Length: 7\r\n\r\n{"a":1}',
      protocol.request('POST', '/v1/call', '{"a":1}'))
  end)

  it('GET has no body headers', function()
    assert.are.equal('GET /v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
      protocol.request('GET', '/v1/health'))
  end)
end)

describe('captured gate responses', function()
  it('200 chunked NDJSON stream: head, chunks, events', function()
    local src = H.source(H.fixture('call-200-stream.raw'))
    local status, headers = protocol.read_head(src)
    assert.are.equal(200, status)
    assert.are.equal('application/x-ndjson', headers['content-type'])
    assert.are.equal('chunked', headers['transfer-encoding'])
    local framer = protocol.ndjson_framer(decode)
    local events = {}
    for chunk in protocol.body_chunks(src, headers) do
      for _, ev in ipairs(framer.feed(chunk)) do events[#events + 1] = ev end
    end
    assert.is_nil(framer.finish())
    assert.are.equal(5, #events)
    for i = 1, 4 do assert.are.equal('delta', events[i].type) end
    assert.are.equal('done', events[5].type)
    assert.are.equal('The sky is blue', events[5].result.output)
    assert.are.equal('incomplete', events[5].result.status)
    assert.are.equal(11, events[5].result.inputTokens)
    assert.are.equal(0, events[5].result.cost)
  end)

  it('200 with a terminal error event', function()
    local src = H.source(H.fixture('call-200-error-event.raw'))
    local status, headers = protocol.read_head(src)
    assert.are.equal(200, status)
    local body = protocol.read_body(src, headers)
    local ev = decode(body)
    assert.is_true(protocol.is_event(ev))
    assert.are.equal('error', ev.type)
    assert.are.equal('SESSION_UNKNOWN_MODEL', ev.error.type)
  end)

  it('400 content-length body maps to the gate TypedError', function()
    local src = H.source(H.fixture('call-400-invalid-envelope.raw'))
    local status, headers = protocol.read_head(src)
    assert.are.equal(400, status)
    assert.are.equal('439', headers['content-length'])
    local err = protocol.error_from_body(protocol.read_body(src, headers), status, decode)
    assert.are.equal('PROTOCOL_INVALID_ENVELOPE', err.type)
    assert.is_false(err.retryable)
    assert.is_true(protocol.is_error(err))
  end)

  it('health', function()
    local src = H.source(H.fixture('health-200.raw'))
    local status, headers = protocol.read_head(src)
    assert.are.equal(200, status)
    assert.are.equal('ok', decode(protocol.read_body(src, headers)).status)
  end)
end)

describe('framing rules', function()
  it('non-JSON non-200 bodies become PROTOCOL_HTTP_ERROR, retryable only for 5xx', function()
    local e4 = protocol.error_from_body('<html>', 404, decode)
    assert.are.equal('PROTOCOL_HTTP_ERROR', e4.type)
    assert.is_false(e4.retryable)
    local e5 = protocol.error_from_body('', 503, decode)
    assert.is_true(e5.retryable)
  end)

  it('a body without framing headers is read to EOF', function()
    local src = H.source('{"type":"idle","sinceMs":1}\n')
    assert.are.equal('{"type":"idle","sinceMs":1}\n', protocol.read_body(src, {}))
  end)

  it('an unterminated line over the cap is a PROTOCOL_INVALID_EVENT', function()
    local framer = protocol.ndjson_framer(decode, 16)
    local ok, err = pcall(framer.feed, string.rep('x', 17))
    assert.is_false(ok)
    assert.are.equal('PROTOCOL_INVALID_EVENT', err.type)
  end)

  it('blank lines are skipped and a final unterminated document is returned by finish()', function()
    local framer = protocol.ndjson_framer(decode)
    local out = framer.feed('\n{"type":"idle","sinceMs":1}\n\n{"type":"done"}')
    assert.are.equal(1, #out)
    assert.are.equal('done', framer.finish().type)
  end)

  it('a truncated chunked body is a PROTOCOL_HTTP_ERROR', function()
    local src = H.source('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n10\r\n{"type":')
    local _, headers = protocol.read_head(src)
    local ok, err = pcall(protocol.read_body, src, headers)
    assert.is_false(ok)
    assert.are.equal('PROTOCOL_HTTP_ERROR', err.type)
  end)

  it('an empty response is NET_ERROR', function()
    local ok, err = pcall(protocol.read_head, H.source(''))
    assert.is_false(ok)
    assert.are.equal('NET_ERROR', err.type)
    assert.is_true(err.retryable)
  end)
end)

describe('conformance events round-trip through the framer', function()
  local fixtures = decode(H.conformance('events.json'))

  it('every fixture event survives encode → NDJSON → decode, at odd chunk sizes', function()
    local names, lines = {}, {}
    for name, ev in pairs(fixtures) do
      names[#names + 1] = name
      lines[#lines + 1] = json.encode(ev)
    end
    local stream = table.concat(lines, '\n') .. '\n'
    local framer = protocol.ndjson_framer(decode)
    local got = {}
    for i = 1, #stream, 7 do
      for _, obj in ipairs(framer.feed(stream:sub(i, i + 6))) do got[#got + 1] = obj end
    end
    assert.is_nil(framer.finish())
    assert.are.equal(#names, #got)
    for i, name in ipairs(names) do
      assert.are.same(fixtures[name], got[i])
      assert.is_true(protocol.is_event(got[i]), name)
    end
  end)
end)
