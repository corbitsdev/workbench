# @corbits/provider-pricing

Static token rates for the workbench catalog seed set, keyed by
`(provider, model)`. Insights uses this at query time when a usage turn
did not carry a provider-reported dollar cost.

Rates are a models.dev snapshot from 2026-04-18,
mapped onto workbench provider names (`google-genai`, `opencode-zen`,
…). Some seed models have a higher-context tier; `lookupRates` picks
the highest tier whose `minContextTokens` the turn's prompt-side tokens
meet. A model with no row here is an honest miss — callers must not
invent `$0`.

Ollama is priced at zero (local). Models with no public list price are
omitted, not guessed.

## Key modules

- `src/rates.ts` — the table
- `src/lookup.ts` — `(provider, model, contextTokens) → rates | null`
- `src/cost.ts` — `(tokens / 1e6) * rate` per class; missing rate + tokens → null
