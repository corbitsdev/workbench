# @corbits/inference-catalog

Agents ask for a model by what the work needs, never by name.

A **concept** — `cheap-loop`, `code-work`, `image-reader` — names a kind of
work. Resolving one against a bench gives back an ordered **chain**: the
models this bench can actually reach that can do that work, cheapest first,
with fallbacks behind the head. A chain, never a single model, because one
model is not a fallback plan.

## What it owns

One table, `inference_catalog.bench_model_policy`: a bench's allow and deny
lists, its price ceilings, and its provider preference. A bench that has
never set one is unconstrained, which is what makes a freshly connected
bench work with no configuration at all.

Everything else is derived at read time from the platform's own catalog:

| Answer                     | Comes from                                                                   |
| -------------------------- | ---------------------------------------------------------------------------- |
| what this bench can reach  | `listVisibleOfferings` ∩ providers with a credential                         |
| what a model can do        | `model_offering.capabilities`                                                |
| what it costs              | `model_pricing` → `resolveActivePrice`, normalized to USD per million tokens |
| which models fit a concept | the offering advertises every capability the concept requires                |
| the order                  | cheapest first for the concept's own token mix, then catalog priority        |

## The modules

- `concepts.ts` — the shipped vocabulary, as data. Twelve concepts, each with
  what it requires, a soft price ceiling, and the token mix that defines
  "cheapest" for it.
- `resolve-chain.ts` — `resolveModelChain`, pure: every read is done by the
  caller and handed in. Also `chainToModelRequirements`, the hand-off to the
  platform's own source resolution.
- `offering-capabilities.ts` — `capabilitiesForDeployment`, what to store on
  a newly created offering, read from the pinned catalog's probe results.
- `price.ts` — per-token decimal strings in, USD per million tokens out. The
  only place that conversion happens.
- `store.ts` / `pg-store.ts` / `routes.ts` — the policy row.
- `workflow-catalog-routes.ts` — the run-authenticated surface
  `@corbits/catalog-tools` calls.

## Rules it holds to

- **Never a fabricated price.** A missing or partial price row is reported as
  unknown, never as zero — a zero would read as free and win every sort.
- **Ceilings are soft.** An over-ceiling model is flagged and sorted last,
  not dropped, so a bench whose only provider is expensive still gets an
  answer. A bench can make its own ceiling hard.
- **An empty chain stays empty.** It comes back with the reasons each
  candidate was excluded, so the caller can say what is missing rather than
  substitute something that cannot do the work.
- **It never resolves credentials.** Its output projects to
  `ModelRequirement[]`; only the platform turns those into runnable sources.
