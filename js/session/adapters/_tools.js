/**
 * Tool format conversion — provider-agnostic JSON-shape converters
 * used by adapters to translate between the unified `ToolSpec` /
 * `ToolCall` envelope shapes and each provider's native wire format.
 *
 * @module session/adapters/_tools
 */

const argsObj = (args) => args || {}

// Tool argument parse failures are expected (models routinely send
// malformed JSON before retrying with corrections). Fall back to
// returning the raw string — downstream adapter code handles the
// type mismatch. Logging here would create warn-level noise.
const parseArgs = (_name, args) => {
  if (typeof args !== 'string') return argsObj(args)
  try {
    return JSON.parse(args)
  } catch {
    return args
  }
}

/**
 * Convert unified tool format to Anthropic's native format.
 * @param {Array} tools  Array of unified tool definitions.
 * @returns {Array} Anthropic-formatted tools.
 */
export const toAnthropicTools = (tools) => tools.map(t => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters
}))

/**
 * Convert unified tool format to OpenAI's native format.
 * @param {Array} tools  Array of unified tool definitions.
 * @returns {Array} OpenAI-formatted tools.
 */
export const toOpenAITools = (tools) => tools.map(t => ({
  type: 'function',
  name: t.name,
  description: t.description,
  parameters: t.parameters
}))

/**
 * Convert unified tool format to Cerebras's native format (classic
 * OpenAI chat completions).
 * @param {Array} tools  Array of unified tool definitions.
 * @returns {Array} Cerebras-formatted tools.
 */
export const toCerebrasTools = (tools) => tools.map(t => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }
}))

/**
 * Convert unified tool format to Gemini's native format (wrapped in
 * `functionDeclarations`).
 * @param {Array} tools  Array of unified tool definitions.
 * @returns {Array} Gemini-formatted tools.
 */
export const toGeminiTools = (tools) => [{
  functionDeclarations: tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }))
}]

/**
 * Normalize Anthropic tool_use blocks to unified format.
 * @param {Array} blocks  Array of `tool_use` content blocks.
 * @returns {Array} Unified toolCalls format.
 */
export const fromAnthropicToolCalls = (blocks) => blocks.map(block => ({
  id: block.id,
  name: block.name,
  arguments: block.input
}))

/**
 * Normalize OpenAI function calls to unified format.
 * @param {Array} calls  Array of OpenAI function call outputs.
 * @returns {Array} Unified toolCalls format.
 */
export const fromOpenAIToolCalls = (calls) => calls.map(call => ({
  id: call.call_id || call.id,
  name: call.name,
  arguments: parseArgs(call.name, call.arguments)
}))

/**
 * Normalize Cerebras tool calls to unified format. Cerebras uses
 * the classic OpenAI chat-completions shape `{id, function: {name,
 * arguments}}`.
 * @param {Array} calls  Array of Cerebras tool_calls.
 * @returns {Array} Unified toolCalls format.
 */
export const fromCerebrasToolCalls = (calls) => calls.map(call => ({
  id: call.id,
  name: call.function.name,
  arguments: parseArgs(call.function.name, call.function.arguments)
}))

/**
 * Normalize Gemini function calls to unified format. Gemini doesn't
 * provide IDs, so we generate them.
 * @param {Array} calls  Array of Gemini `functionCall` parts.
 * @returns {Array} Unified toolCalls format.
 */
export const fromGeminiToolCalls = (calls) => calls.map((call, index) => {
  const tc = {
    id: `gemini_call_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`,
    name: call.name,
    arguments: call.args || {}
  }
  if (call.thoughtSignature) tc.thoughtSignature = call.thoughtSignature
  return tc
})

/**
 * Convert tool choice to provider-specific format.
 * @param {string} provider  Provider name (`'anthropic'`, `'openai'`,
 *   `'cerebras'`, `'mistral'`, `'gemini'`).
 * @param {string|object} choice  Tool choice (`'auto'`, `'required'`,
 *   `'none'`, or a specific tool name).
 * @returns {any} Provider-formatted tool choice.
 */
export const toToolChoice = (provider, choice) => {
  if (!choice) return undefined

  switch (provider) {
    case 'anthropic':
      if (choice === 'auto') return { type: 'auto' }
      if (choice === 'required') return { type: 'any' }
      if (choice === 'none') return { type: 'none' }
      if (typeof choice === 'string') return { type: 'tool', name: choice }
      return choice

    case 'openai':
      if (choice === 'auto') return 'auto'
      if (choice === 'required') return 'required'
      if (choice === 'none') return 'none'
      if (typeof choice === 'string') return { type: 'function', function: { name: choice } }
      return choice

    case 'cerebras':
      if (choice === 'auto') return 'auto'
      if (choice === 'required') return 'required'
      if (choice === 'none') return 'none'
      if (typeof choice === 'string') return { type: 'function', function: { name: choice } }
      return choice

    case 'mistral':
      if (choice === 'auto') return 'auto'
      if (choice === 'required') return 'any'
      if (choice === 'none') return 'none'
      if (typeof choice === 'string') return { type: 'function', function: { name: choice } }
      return choice

    case 'gemini':
      // Gemini uses toolConfig.functionCallingConfig
      if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } }
      if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } }
      if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } }
      if (typeof choice === 'string') {
        return {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: [choice]
          }
        }
      }
      return choice

    default:
      return choice
  }
}
