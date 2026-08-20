# @corbits/catalog-tools

Three read-only tools that let an agent choose a model without ever naming
one.

- **`list_model_concepts`** — the kinds of work this workbench can pick a
  model for, and how many models it currently has for each.
- **`pick_models`** — the models this workbench can actually reach for a kind
  of work, cheapest first, with fallbacks behind the head.
- **`estimate_run_cost`** — what a run would cost on those models, or an
  honest "no price on record" when a model is unpriced.

A model named from memory is a guess about a bench the agent cannot see. A
kind of work is a question this bench can answer from its own connected
providers, capability data, and prices — which is why `pick_models` takes a
concept or a capability set and refuses both at once, and never takes a model
name at all.

Everything comes from `@corbits/inference-catalog`'s run-authenticated
surface at `/api/workflow-inference-catalog`, reached with the sidecar bearer
token and run address like every other workflow-run tool bundle. All three
tools read only, so none is gated behind approval.
