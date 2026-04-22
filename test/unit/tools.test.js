import { describe, test, expect } from 'vitest'
import {
  toAnthropicTools,
  toOpenAITools,
  toCerebrasTools,
  toGeminiTools,
  fromAnthropicToolCalls,
  fromOpenAIToolCalls,
  fromCerebrasToolCalls,
  fromGeminiToolCalls,
  toToolChoice
} from '../../js/session/adapters/_tools.js'

const sampleTools = [
  {
    name: 'get_weather',
    description: 'Get the weather for a location',
    parameters: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location']
    }
  },
  {
    name: 'search',
    description: 'Search the web',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  }
]

describe('toAnthropicTools', () => {
  test('maps parameters to input_schema', () => {
    const result = toAnthropicTools(sampleTools)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      name: 'get_weather',
      description: 'Get the weather for a location',
      input_schema: sampleTools[0].parameters
    })
    expect(result[0]).not.toHaveProperty('parameters')
  })

  test('handles empty array', () => {
    expect(toAnthropicTools([])).toEqual([])
  })
})

describe('toOpenAITools', () => {
  test('wraps with type function, keeps parameters flat', () => {
    const result = toOpenAITools(sampleTools)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      type: 'function',
      name: 'get_weather',
      description: 'Get the weather for a location',
      parameters: sampleTools[0].parameters
    })
  })

  test('handles empty array', () => {
    expect(toOpenAITools([])).toEqual([])
  })
})

describe('toCerebrasTools', () => {
  test('wraps with type function, nests under function key', () => {
    const result = toCerebrasTools(sampleTools)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the weather for a location',
        parameters: sampleTools[0].parameters
      }
    })
    expect(result[0]).not.toHaveProperty('name')
  })

  test('handles empty array', () => {
    expect(toCerebrasTools([])).toEqual([])
  })
})

describe('toGeminiTools', () => {
  test('wraps in functionDeclarations array', () => {
    const result = toGeminiTools(sampleTools)
    expect(result).toHaveLength(1)
    expect(result[0].functionDeclarations).toHaveLength(2)
    expect(result[0].functionDeclarations[0]).toEqual({
      name: 'get_weather',
      description: 'Get the weather for a location',
      parameters: sampleTools[0].parameters
    })
  })

  test('handles empty array', () => {
    const result = toGeminiTools([])
    expect(result).toEqual([{ functionDeclarations: [] }])
  })
})

describe('fromAnthropicToolCalls', () => {
  test('maps id/name/input to id/name/arguments', () => {
    const blocks = [
      { id: 'tc_1', name: 'get_weather', input: { location: 'Paris' } }
    ]
    const result = fromAnthropicToolCalls(blocks)
    expect(result).toEqual([
      { id: 'tc_1', name: 'get_weather', arguments: { location: 'Paris' } }
    ])
  })
})

describe('fromOpenAIToolCalls', () => {
  test('handles call_id and JSON-string arguments', () => {
    const calls = [
      { call_id: 'call_abc', name: 'search', arguments: '{"query":"test"}' }
    ]
    const result = fromOpenAIToolCalls(calls)
    expect(result).toEqual([
      { id: 'call_abc', name: 'search', arguments: { query: 'test' } }
    ])
  })

  test('handles id field and object arguments', () => {
    const calls = [
      { id: 'call_xyz', name: 'search', arguments: { query: 'test' } }
    ]
    const result = fromOpenAIToolCalls(calls)
    expect(result).toEqual([
      { id: 'call_xyz', name: 'search', arguments: { query: 'test' } }
    ])
  })

  test('prefers call_id over id', () => {
    const calls = [
      { call_id: 'preferred', id: 'fallback', name: 'search', arguments: '{}' }
    ]
    expect(fromOpenAIToolCalls(calls)[0].id).toBe('preferred')
  })
})

describe('fromCerebrasToolCalls', () => {
  test('extracts from function.name / function.arguments', () => {
    const calls = [
      { id: 'c_1', function: { name: 'get_weather', arguments: '{"location":"London"}' } }
    ]
    const result = fromCerebrasToolCalls(calls)
    expect(result).toEqual([
      { id: 'c_1', name: 'get_weather', arguments: { location: 'London' } }
    ])
  })

  test('handles object arguments', () => {
    const calls = [
      { id: 'c_2', function: { name: 'search', arguments: { query: 'hello' } } }
    ]
    const result = fromCerebrasToolCalls(calls)
    expect(result[0].arguments).toEqual({ query: 'hello' })
  })
})

describe('fromGeminiToolCalls', () => {
  test('generates IDs and maps args to arguments', () => {
    const calls = [
      { name: 'get_weather', args: { location: 'Tokyo' } }
    ]
    const result = fromGeminiToolCalls(calls)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('get_weather')
    expect(result[0].arguments).toEqual({ location: 'Tokyo' })
    expect(result[0].id).toMatch(/^gemini_call_/)
  })

  test('defaults to empty object when args is missing', () => {
    const calls = [{ name: 'noop' }]
    const result = fromGeminiToolCalls(calls)
    expect(result[0].arguments).toEqual({})
  })

  test('generates unique IDs for multiple calls', () => {
    const calls = [
      { name: 'tool_a', args: {} },
      { name: 'tool_b', args: {} }
    ]
    const result = fromGeminiToolCalls(calls)
    expect(result[0].id).not.toBe(result[1].id)
  })

  test('preserves thoughtSignature when present', () => {
    const calls = [
      { name: 'tool_a', args: {}, thoughtSignature: 'sig123' }
    ]
    const result = fromGeminiToolCalls(calls)
    expect(result[0].thoughtSignature).toBe('sig123')
  })
})

describe('parseArgs (via fromOpenAIToolCalls)', () => {
  test('malformed JSON warns and returns raw string', () => {
    const calls = [
      { call_id: 'c1', name: 'search', arguments: '{bad json' }
    ]
    const result = fromOpenAIToolCalls(calls)
    expect(result[0].arguments).toBe('{bad json')
  })

  test('empty string returns empty string', () => {
    const calls = [
      { call_id: 'c1', name: 'search', arguments: '' }
    ]
    const result = fromOpenAIToolCalls(calls)
    expect(result[0].arguments).toBe('')
  })

  test('null arguments returns empty object', () => {
    const calls = [
      { call_id: 'c1', name: 'search', arguments: null }
    ]
    const result = fromOpenAIToolCalls(calls)
    expect(result[0].arguments).toEqual({})
  })

  test('undefined arguments returns empty object', () => {
    const calls = [
      { call_id: 'c1', name: 'search', arguments: undefined }
    ]
    const result = fromOpenAIToolCalls(calls)
    expect(result[0].arguments).toEqual({})
  })

  test('valid JSON string is parsed', () => {
    const calls = [
      { call_id: 'c1', name: 'search', arguments: '{"a":1}' }
    ]
    expect(fromOpenAIToolCalls(calls)[0].arguments).toEqual({ a: 1 })
  })

  test('object arguments pass through', () => {
    const args = { a: 1 }
    const calls = [
      { call_id: 'c1', name: 'search', arguments: args }
    ]
    expect(fromOpenAIToolCalls(calls)[0].arguments).toBe(args)
  })
})

describe('toToolChoice', () => {
  describe('anthropic', () => {
    test('auto', () => {
      expect(toToolChoice('anthropic', 'auto')).toEqual({ type: 'auto' })
    })

    test('required maps to any', () => {
      expect(toToolChoice('anthropic', 'required')).toEqual({ type: 'any' })
    })

    test('none', () => {
      expect(toToolChoice('anthropic', 'none')).toEqual({ type: 'none' })
    })

    test('named tool', () => {
      expect(toToolChoice('anthropic', 'get_weather')).toEqual({ type: 'tool', name: 'get_weather' })
    })

    test('passthrough object', () => {
      const custom = { type: 'custom' }
      expect(toToolChoice('anthropic', custom)).toBe(custom)
    })
  })

  describe('openai', () => {
    test('auto', () => {
      expect(toToolChoice('openai', 'auto')).toBe('auto')
    })

    test('required', () => {
      expect(toToolChoice('openai', 'required')).toBe('required')
    })

    test('none', () => {
      expect(toToolChoice('openai', 'none')).toBe('none')
    })

    test('named tool', () => {
      expect(toToolChoice('openai', 'get_weather')).toEqual({
        type: 'function',
        function: { name: 'get_weather' }
      })
    })

    test('passthrough object', () => {
      const custom = { type: 'custom' }
      expect(toToolChoice('openai', custom)).toBe(custom)
    })
  })

  describe('cerebras', () => {
    test('auto', () => {
      expect(toToolChoice('cerebras', 'auto')).toBe('auto')
    })

    test('required', () => {
      expect(toToolChoice('cerebras', 'required')).toBe('required')
    })

    test('none', () => {
      expect(toToolChoice('cerebras', 'none')).toBe('none')
    })

    test('named tool', () => {
      expect(toToolChoice('cerebras', 'get_weather')).toEqual({
        type: 'function',
        function: { name: 'get_weather' }
      })
    })
  })

  describe('mistral', () => {
    test('auto', () => {
      expect(toToolChoice('mistral', 'auto')).toBe('auto')
    })

    test('required maps to any', () => {
      expect(toToolChoice('mistral', 'required')).toBe('any')
    })

    test('none', () => {
      expect(toToolChoice('mistral', 'none')).toBe('none')
    })

    test('named tool', () => {
      expect(toToolChoice('mistral', 'get_weather')).toEqual({
        type: 'function',
        function: { name: 'get_weather' }
      })
    })
  })

  describe('gemini', () => {
    test('auto', () => {
      expect(toToolChoice('gemini', 'auto')).toEqual({
        functionCallingConfig: { mode: 'AUTO' }
      })
    })

    test('required maps to ANY', () => {
      expect(toToolChoice('gemini', 'required')).toEqual({
        functionCallingConfig: { mode: 'ANY' }
      })
    })

    test('none', () => {
      expect(toToolChoice('gemini', 'none')).toEqual({
        functionCallingConfig: { mode: 'NONE' }
      })
    })

    test('named tool', () => {
      expect(toToolChoice('gemini', 'get_weather')).toEqual({
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['get_weather']
        }
      })
    })
  })

  describe('edge cases', () => {
    test('falsy choice returns undefined', () => {
      expect(toToolChoice('openai', null)).toBeUndefined()
      expect(toToolChoice('openai', undefined)).toBeUndefined()
      expect(toToolChoice('openai', '')).toBeUndefined()
    })

    test('unknown provider passes through', () => {
      expect(toToolChoice('unknown', 'auto')).toBe('auto')
    })
  })
})
