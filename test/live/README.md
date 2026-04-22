# Live adapter tests

One suite per registered text adapter, hitting real provider APIs.
**Not** run by `npm test`. They exist to catch SDK / protocol drift
that mocked unit tests can't see (a provider renaming a field or
changing an event shape silently breaks our adapter otherwise).

Each provider runs three checks:

1. **happy path** — completed status + delta stream (streaming
   adapters only) + non-zero input/output tokens.
2. **outputBudget truncation** — small budget + demanding prompt
   produces `status: 'incomplete'` + `warning: 'insufficientOutputBudget'`
   (the mohdel status contract).
3. **cancel mid-stream** (streaming only) — `AbortSignal` reaches the
   SDK and the `done` event carries `warning: 'cancelled'`.

## Running

Each provider's suite is gated on its API key env var — missing key
→ skipped, not failed. So `npm run test:live` with no keys exits
clean.

```bash
# Any single provider (others skip):
ANTHROPIC_API_SK=sk-ant-...  npm run test:live
OPENAI_API_SK=sk-...         npm run test:live
GEMINI_API_SK=AI...          npm run test:live

# All together:
ANTHROPIC_API_SK=... OPENAI_API_SK=... GEMINI_API_SK=...  npm run test:live
```

Env var names match `src/lib/providers.js` (`<PROVIDER>_API_SK`) —
the same keys the `mo` CLI and the `test:provider` suite expect.

All eleven providers are covered: **anthropic, openai, gemini, xai,
fireworks, openrouter, cerebras, deepseek, groq, mistral, novita.**

## Cost

Each happy-path and cancel test makes one real API call to a cheap
model. The truncation test is capped at ~16 output tokens. A full
11-provider run is a few cents. Don't loop this in CI without
thinking about it.

## Model overrides

Defaults target the cheapest current small models. Override if the
default is unavailable in your account:

- `MOHDEL_LIVE_ANTHROPIC_MODEL` (default: `claude-haiku-4-5`)
- `MOHDEL_LIVE_OPENAI_MODEL` (default: `gpt-5-mini`)
- `MOHDEL_LIVE_GEMINI_MODEL` (default: `gemini-2.5-flash`)
- `MOHDEL_LIVE_XAI_MODEL` (default: `grok-4-1-fast-non-reasoning`)
- `MOHDEL_LIVE_FIREWORKS_MODEL` (default: `accounts/fireworks/models/kimi-k2p5`)
- `MOHDEL_LIVE_OPENROUTER_MODEL` (default: `anthropic/claude-haiku-4-5`)
- `MOHDEL_LIVE_CEREBRAS_MODEL` (default: `gpt-oss-120b`)
- `MOHDEL_LIVE_DEEPSEEK_MODEL` (default: `deepseek-chat`)
- `MOHDEL_LIVE_GROQ_MODEL` (default: `llama-3.3-70b-versatile`)
- `MOHDEL_LIVE_MISTRAL_MODEL` (default: `mistral-small-latest`)
- `MOHDEL_LIVE_NOVITA_MODEL` (default: `kwaipilot/kat-coder-pro`)
