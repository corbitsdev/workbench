# Offering capability resolution

How `@corbits/inference-catalog`'s `offering-capabilities.ts` decides what a
deployment can do.

## Why this exists

`model_offering.capabilities` is the column every capability filter reads —
this package's chain resolution and the platform's own source resolution
alike. Nothing populated it before, so it was empty everywhere. This module
is the source of truth, and it only ever reports capabilities the pinned
catalog observed on the wire:

- `exact-deployment` — this exact (baseURL, model) was probed; use its list.
- `same-model-wire` — the model was probed on other deployments speaking the
  same wire, and this one relays it; use the intersection across those
  deployments, so a relay never claims more than every probed deployment
  demonstrated.
- `unknown` — no probe covers it; empty list, said plainly.

An empty list is deliberately not softened with a per-adapter baseline: "an
OpenAI-compatible endpoint serves plain text" is false for the embedding
models such endpoints also serve, and a wrong capability tag routes real
work to a model that cannot do it.

## Storable vocabulary

The pinned catalog's vocabulary is a superset of what the platform can
store: it bakes in `long-context` and `prompt-caching`, which `@intx/types`'
`Capability` does not accept. Everything this module reports is filtered
down to the storable vocabulary, so a seed never posts a value the hub will
reject.
