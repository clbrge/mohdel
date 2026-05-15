# Cookbook

Copy-paste recipes for common tasks. Each one stands alone — no setup beyond `npm install -g mohdel` and at least one provider key in `~/.config/mohdel/environment` (run `mo` interactively if you haven't yet).

The CLI recipes use `mo ask`. The JS recipes use the in-process **factory** (`import mohdel from 'mohdel'`) which is right for scripts, CLIs, and single-process services. For cross-process / fault-isolated production setups, swap in `mohdel/client` over a `thin-gate` socket — see [INTEGRATION.md](../INTEGRATION.md).

- [1. Summarize a file](#1-summarize-a-file)
- [2. Stream output to the terminal](#2-stream-output-to-the-terminal)
- [3. Swap providers without changing code](#3-swap-providers-without-changing-code)
- [4. Tool-use round trip](#4-tool-use-round-trip)
- [5. Vision: ask about an image](#5-vision-ask-about-an-image)
- [6. Batch process N prompts and total the cost](#6-batch-process-n-prompts-and-total-the-cost)

---

## 1. Summarize a file

**Shell:**

```bash
cat article.txt | mo ask anthropic/claude-haiku-4-5 "summarize in 3 bullets"
```

`mo ask` reads stdin and joins it with any positional prompt. `--json` makes it machine-readable; pipe through `jq` for fields:

```bash
cat article.txt | mo ask anthropic/claude-haiku-4-5 "summarize in 3 bullets" --json | jq -r '.output'
cat article.txt | mo ask anthropic/claude-haiku-4-5 "summarize in 3 bullets" --json | jq '.cost'
```

**JS:**

```js
import mohdel from 'mohdel'
import { readFile } from 'fs/promises'

const mo = await mohdel()
const article = await readFile('article.txt', 'utf8')
const result = await mo.use('anthropic/claude-haiku-4-5').answer(
  `Summarize in 3 bullets:\n\n${article}`
)
console.log(result.output)
console.error(`Cost: $${result.cost.toFixed(4)} (${result.inputTokens} in, ${result.outputTokens} out)`)
```

---

## 2. Stream output to the terminal

**Shell:**

```bash
mo ask anthropic/claude-sonnet-4-6 --stream "write a short story about a lighthouse"
```

**JS** — pass a `realtimeHandler` to write deltas as they arrive:

```js
import mohdel from 'mohdel'

const mo = await mohdel()
const result = await mo.use('anthropic/claude-sonnet-4-6').answer(
  'Write a short story about a lighthouse.',
  {
    realtimeHandler: (delta) => process.stdout.write(delta),
    bufferOpts: { maxChars: 1, maxMs: 0 } // flush every char
  }
)
process.stdout.write('\n')
console.error(`\nDone. ${result.outputTokens} tokens, $${result.cost.toFixed(4)}`)
```

Tune `bufferOpts` (`maxChars`, `maxMs`) to coalesce deltas if you're rendering to something slower than a TTY.

---

## 3. Swap providers without changing code

The whole point of the unified interface — the provider/model id is the only thing that changes:

```js
import mohdel from 'mohdel'

const mo = await mohdel()
const MODEL = process.env.MODEL || 'anthropic/claude-haiku-4-5'

const result = await mo.use(MODEL).answer('Explain monads in one paragraph.')
console.log(`[${MODEL}] $${result.cost.toFixed(4)}`)
console.log(result.output)
```

Run it three ways:

```bash
MODEL=anthropic/claude-haiku-4-5    node script.js
MODEL=openai/gpt-5.4-mini           node script.js
MODEL=gemini/gemini-3-flash-preview node script.js
```

Tokens, cost, and the `{ status, output, … }` shape are identical across all three. Differences in thinking budget, cache pricing, and output limits are absorbed by the catalog entry — see [docs/CATALOG.md](CATALOG.md).

---

## 4. Tool-use round trip

Mohdel exposes the inference primitive — *you* run the tool loop. A minimal one-tool round trip:

```js
import mohdel from 'mohdel'

const mo = await mohdel()
const model = mo.use('anthropic/claude-sonnet-4-6')

const tools = [{
  name: 'get_weather',
  description: 'Get current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city']
  }
}]

const messages = [{ role: 'user', content: "What's the weather in Lisbon?" }]

// First call — model decides whether to use a tool
let result = await model.answer(messages, { tools })

while (result.status === 'tool_use') {
  const calls = result.toolCalls || []

  // Echo the assistant's tool-call turn back so the model has full context
  messages.push({
    role: 'assistant',
    content: result.output || '',
    toolCalls: calls
  })

  // Run each tool and append a tool-role message per call
  for (const call of calls) {
    // Your real tool would do fetch() / db lookup / etc.
    const fake = call.name === 'get_weather'
      ? { temp: 19, condition: 'cloudy' }
      : { error: 'unknown tool' }
    messages.push({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: JSON.stringify(fake)
    })
  }

  result = await model.answer(messages, { tools })
}

console.log(result.output)
```

The `Message` / `ToolSpec` / `ToolCall` shapes are mohdel's canonical (provider-agnostic) form — the adapter translates to provider-native `tool_use` / `function_call` / `tool_calls` representations. Field reference: [`js/core/envelope.js`](../js/core/envelope.js).

---

## 5. Vision: ask about an image

```js
import mohdel from 'mohdel'
import { resolve } from 'path'

const mo = await mohdel()

const result = await mo.use('anthropic/claude-sonnet-4-6').answer(
  'Describe this chart in one sentence.',
  {
    images: [{
      fileUri: `file://${resolve('chart.png')}`,
      mimeType: 'image/png'
    }]
  }
)
console.log(result.output)
```

`fileUri` accepts three schemes: `file://` (loaded + base64-encoded for you), `https://` (passed as URL reference where the provider accepts it), and inline `data:image/png;base64,…` URIs.

Catalog entries advertise vision support via `inputFormat` containing `"image"`. If the model doesn't accept images (`inputFormat: ["text"]`), the envelope validator rejects the call before it hits the wire.

---

## 6. Batch process N prompts and total the cost

```js
import mohdel from 'mohdel'

const mo = await mohdel()
const model = mo.use('gemini/gemini-3-flash-preview') // pick something cheap + fast

const prompts = [
  'Translate "good morning" to Japanese.',
  'Translate "thank you" to Japanese.',
  'Translate "see you tomorrow" to Japanese.'
]

let totalCost = 0
let totalIn = 0
let totalOut = 0

const results = await Promise.all(prompts.map(async (p) => {
  const r = await model.answer(p)
  totalCost += r.cost
  totalIn += r.inputTokens
  totalOut += r.outputTokens
  return r.output
}))

for (const out of results) console.log('-', out)
console.error(`\nTotal: $${totalCost.toFixed(4)} (${totalIn} in, ${totalOut} out)`)
```

For real batch loads, mind provider rate limits (`mo rl show <provider>`); the in-process factory enforces the limits configured in `providers.json` / `curated.json`. For cross-process quota across many workers, run `thin-gate` and use `mohdel/client` — quota lives in the gate.

---

## See also

- [README.md](../README.md) — install, CLI, library overview
- [INTEGRATION.md](../INTEGRATION.md) — full library API (factory, client, options, errors)
- [CATALOG.md](CATALOG.md) — `curated.json` field reference
- [GLOSSARY.md](GLOSSARY.md) — terms
