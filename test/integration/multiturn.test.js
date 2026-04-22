import { execSync } from 'child_process'
import { describe, test, expect } from 'vitest'
import { loadDefaultEnv } from '../../src/lib/common.js'
import mohdel from '../../src/lib/index.js'
import providers from '../../src/lib/providers.js'
import { getCuratedCacheSnapshot } from '../../src/lib/curated-cache.js'

loadDefaultEnv()

// Gemini requires model-generated thoughtSignature on functionCall parts,
// so manually constructed tool histories are rejected with 400.
const NO_SYNTHETIC_HISTORY = new Set(['gemini'])

const IMAGE_TYPES = new Set(['image'])

const tagFilter = process.env.TAG || null

// Deterministic values from simple unix commands
const HOSTNAME = execSync('hostname').toString().trim()
const OS_NAME = execSync('uname -s').toString().trim()

const tools = [
  {
    name: 'get_hostname',
    description: 'Returns the hostname of the current machine',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'get_os',
    description: 'Returns the operating system name',
    parameters: { type: 'object', properties: {} }
  }
]

describe('multi-turn messages integration', async () => {
  // Silent default — only need to verify integration behavior, not log routing.
  const m = await mohdel()
  const curated = getCuratedCacheSnapshot()

  // Group curated models by provider. Skip entries without any tags —
  // an un-tagged model is usually a stale/unvalidated curate that
  // produces noise in the smoke suite (e.g. a retired upstream variant).
  // Explicit `TAG=...` filter narrows further.
  const byProvider = {}
  for (const [fullId, meta] of Object.entries(curated)) {
    const provider = fullId.split('/')[0]
    if (!providers[provider]) continue
    if (!meta.tags || meta.tags.length === 0) continue
    if (tagFilter && !meta.tags.includes(tagFilter)) continue
    if (!byProvider[provider]) byProvider[provider] = []
    byProvider[provider].push(fullId)
  }

  for (const [provider, modelIds] of Object.entries(byProvider)) {
    const envVar = providers[provider].apiKeyEnv
    const hasKey = envVar && !!process.env[envVar]
    const sdk = providers[provider].sdk
    // Text-answer path only — skip image-gen models (those live in
    // provider.test.js's image() smoke). A provider with only image
    // models is entirely skipped.
    const textModels = modelIds.filter(id => !IMAGE_TYPES.has(curated[id].type))
    if (textModels.length === 0) continue
    const modelId = textModels[0]

    describe.skipIf(!hasKey)(`${provider} (${modelId})`, () => {
      // ── system + user + assistant history ──────────────────────────
      // Exercises: system, { role: 'user', content },
      //            { role: 'assistant', content } (text-only)
      test('multi-turn context', async () => {
        const llm = m.use(modelId)
        const result = await llm.answer({
          system: 'You are a calculator. Reply with just the number, nothing else.',
          messages: [
            { role: 'user', content: 'What is 2 + 2?' },
            { role: 'assistant', content: '4' },
            { role: 'user', content: 'Add 3 to that' }
          ]
        })

        expect(result.status).toBe('completed')
        expect(result.output).toContain('7')
        expect(result.inputTokens).toBeGreaterThan(0)
        expect(result.outputTokens).toBeGreaterThan(0)
      }, 30_000)

      if (m.use(modelId).supportsTools) {
        // ── pre-built history with every message type ────────────────
        // Exercises: system, user, assistant with content + toolCalls,
        //            consecutive tool_result with toolCallId + toolName
        test.skipIf(NO_SYNTHETIC_HISTORY.has(sdk))('constructed tool history', async () => {
          const llm = m.use(modelId)
          const result = await llm.answer({
            system: 'Summarize the tool results. Include the exact values returned.',
            messages: [
              { role: 'user', content: 'Get the hostname and OS name of this machine.' },
              {
                role: 'assistant',
                content: 'Let me check both.',
                toolCalls: [
                  { id: 'call_001', name: 'get_hostname', arguments: {} },
                  { id: 'call_002', name: 'get_os', arguments: {} }
                ]
              },
              { role: 'tool_result', toolCallId: 'call_001', content: HOSTNAME, toolName: 'get_hostname' },
              { role: 'tool_result', toolCallId: 'call_002', content: OS_NAME, toolName: 'get_os' }
            ]
          }, { tools, toolChoice: 'none' })

          expect(result.status).toBe('completed')
          expect(result.output.toLowerCase()).toContain(HOSTNAME.toLowerCase())
          expect(result.inputTokens).toBeGreaterThan(0)
        }, 30_000)

        // ── live tool call → result → completion ─────────────────────
        // Exercises: structured input with toolChoice, live provider IDs,
        //            assistant with toolCalls from real response,
        //            tool_result fed back in follow-up structured call
        test('tool round-trip', async () => {
          const llm = m.use(modelId)

          // Step 1: ask the model to call a tool
          const step1 = await llm.answer({
            system: 'Use the get_hostname tool when asked about the hostname.',
            messages: [
              { role: 'user', content: 'What is the hostname of this machine?' }
            ]
          }, {
            tools: [tools[0]],
            toolChoice: 'required'
          })

          expect(step1.status).toBe('tool_use')
          expect(step1.toolCalls).toBeDefined()
          expect(step1.toolCalls.length).toBeGreaterThan(0)
          expect(step1.toolCalls[0].name).toBe('get_hostname')

          // Step 2: feed back the deterministic tool result
          const step2 = await llm.answer({
            system: 'Use the get_hostname tool when asked about the hostname.',
            messages: [
              { role: 'user', content: 'What is the hostname of this machine?' },
              { role: 'assistant', content: step1.output, toolCalls: step1.toolCalls },
              {
                role: 'tool_result',
                toolCallId: step1.toolCalls[0].id,
                content: HOSTNAME,
                toolName: 'get_hostname'
              }
            ]
          }, { tools: [tools[0]] })

          expect(step2.status).toBe('completed')
          expect(step2.output.toLowerCase()).toContain(HOSTNAME.toLowerCase())
        }, 60_000)
      }
    })
  }
})
