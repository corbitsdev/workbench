# Ollama context defaults

Why `@corbits/inference-catalog`'s `ollama-context-defaults.ts` exists and
how it plugs into inference.

## The problem

`@intx/inference`'s built-in OpenAI-shaped adapter defaults output tokens to
`options.maxTokens ?? 4096` when a caller sets none, and Ollama's own
OpenAI-compatible endpoint silently defaults `options.num_ctx` (its real
context window) to a small built-in size when nothing sets it either —
truncating real conversations for every locally served chat agent, with no
error to say so.

## Where the fix lands

`@corbits/ollama-adapter`'s `OllamaAdapterConfig` is where an override
actually reaches the built request body (`resolveOverride` and
`createOllamaAdapter`). This module supplies the real per-model values,
stored as a `model_offering`'s `quirks` column so it reaches
`InferenceSource.quirks` — and from there the adapter — through the
platform's existing resolution, with no parallel override path.

## Table entries are native windows, not extended ceilings

Each table entry is the model's advertised *native* context window, not a
YaRN/rope-extended ceiling: requesting a `num_ctx` past what a model (and
the host's memory) can back can fail allocation or force heavy swap, a real
operational risk rather than a convention to enforce. A model absent from
the table gets no override — Ollama's own default stands rather than this
module guessing at a ceiling it cannot back up.

## `default` vs. `perModel`

Each offering is already scoped to one exact model, so `quirksForDeployment`
wraps the resolved override in `default` — the field `resolveOverride`
applies when no `perModel` entry is present — rather than `perModel`, which
exists for a single shared connection serving several models through one
quirks bag.
