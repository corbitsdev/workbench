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

## Managing offerings

Three more tools let an agent write to the tenant's own inference catalog,
through the tenant-admin catalog routes
(`vendor/intx/hub-api/src/routes/{models,model-providers,model-offerings}.ts`)
rather than the read-only concept surface above.

- **`create_offering`** — pairs a model (by canonical name) with a model
  provider (by name), both already present in this workbench's own catalog,
  at a given priority with a set of advertised capabilities. Gated behind
  `approval: "ask"`: it changes what this bench can resolve to at runtime.
- **`set_offering_priority`** — reorders an offering this workbench already
  owns directly, changing where it falls in source-resolution fallback
  order. Ungated: it only reorders an offering already live.
- **`disable_offering`** — restricts an offering this workbench already owns
  directly, taking it out of source resolution without deleting its pricing
  history. Gated behind `approval: "ask"`: running instances resolved
  through it fail over to the next eligible source.

`create_offering` never invents a model or provider id — it resolves the
given canonical name and provider name against this tenant's own catalog
listing first, and refuses rather than guessing when neither is found.
