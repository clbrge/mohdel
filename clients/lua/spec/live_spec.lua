-- Runs only against a live thin-gate: set MOHDEL_GATE_SOCKET (and
-- MOHDEL_GATE_ADMIN_SOCKET for health). MOHDEL_LIVE_MODEL picks the
-- catalog key (default local/llama3.1-8b); MOHDEL_LUA_TRANSPORT picks
-- 'luasocket' (default) or 'curl'.
local socket_path = os.getenv('MOHDEL_GATE_SOCKET')

if socket_path then
  local mohdel = require('mohdel')
  local model = os.getenv('MOHDEL_LIVE_MODEL') or 'local/llama3.1-8b'
  local c = mohdel.connect({
    socket = socket_path,
    admin_socket = os.getenv('MOHDEL_GATE_ADMIN_SOCKET'),
    transport = os.getenv('MOHDEL_LUA_TRANSPORT'),
  })
  local function envelope(extra)
    local e = { callId = 'lua-' .. os.time() .. '-' .. math.random(1e6), authId = 'lua-live',
      auth = { key = os.getenv('MOHDEL_LIVE_KEY') or '' }, model = model,
      prompt = 'Say the single word "hi".', outputBudget = 20 }
    for k, v in pairs(extra or {}) do e[k] = v end
    return e
  end

  describe('live thin-gate (' .. model .. ')', function()
    it('streams deltas and a done result with tokens', function()
      local deltas, result = 0, nil
      for ev in c:call(envelope()):events() do
        if ev.type == 'delta' then deltas = deltas + 1 end
        if ev.type == 'done' then result = ev.result end
        assert.are_not.equal('error', ev.type, ev.error and ev.error.message)
      end
      assert.is_true(deltas > 0)
      assert.are.equal('completed', result.status)
      assert.is_true(result.inputTokens > 0)
      assert.is_true(result.outputTokens > 0)
      assert.are.equal('number', type(result.cost))
    end)

    it('outputBudget=1 + demanding prompt → incomplete', function()
      local result = c:call(envelope({ outputBudget = 1, prompt = 'Write a detailed essay about tigers.' })):collect()
      assert.are.equal('incomplete', result.status)
      assert.are.equal('insufficientOutputBudget', result.warning)
    end)

    it('closing mid-stream cancels; the next call still works', function()
      local stream = c:call(envelope({
        outputBudget = 200, prompt = 'Count slowly from 1 to 100, one number per line.',
      }))
      assert.are.equal('delta', stream:next().type)
      stream:close()
      assert.are.equal('completed', c:call(envelope()):collect().status)
    end)

    if os.getenv('MOHDEL_GATE_ADMIN_SOCKET') then
      it('health', function()
        assert.are.equal('ok', c:health().status)
      end)
    end
  end)
end
