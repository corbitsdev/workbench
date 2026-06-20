# Deploying workflows to the hub

Workflows are git-backed assets, not hub code. A workflow is authored as a
native `@intx/workflow` definition in its own package, then **pushed** to a
running hub, which commits it to a git-backed `workflow` repo and launches it on
the sidecar. The hub imports no workflow code — adding a workflow needs no hub
change.

## Model

- **Author**: each workflow is a package under `workflows/<kind>/` named
  `@workbench/workflow-<kind>`, exporting `kind` and `workflow` (a
  `defineWorkflow(...)` definition).
- **Push**: `workflows:push` imports `@workbench/workflow-<kind>`, serializes its
  `workflow`, and `POST`s the definition to `POST /api/internal/workflows/deploy`.
- **Deploy** (hub): validates the definition, resolves the tenant deploy config
  (the base inference source from the tenant LLM credential), and hands it to the
  exported `@intx/workflow-deploy` orchestrator. The orchestrator runs the
  capability walk, commits `workflow.json` + `capability-declarations.json` to the
  git-backed `workflow` repo, launches one session per step, and sends the
  multi-step deploy frame to the sidecar.
- **Run** (sidecar): the workflow-host supervisor reads `workflow.json` from the
  `workflow` repo and drives the steps, including `awaitSignal` human gates.

## Authorization

Deploy is an **operator action**, not a user action: the route
(`POST /api/internal/workflows/deploy`) is gated by the hub **service token**
(`Authorization: Bearer <token>`), the same gate the other `/api/internal`
routes use. This matters because the orchestrator auto-approves the grants the
posted definition declares — only a trusted operator holding the deploy secret
may push. A member session cannot reach the route.

(Finer-grained, per-user admin gating would need a hub role mechanism, which does
not exist today — tracked as a follow-up.)

## Pushing a workflow

The hub and sidecar must be running on the **same interchange pin**, and the
tenant LLM credential (provider `openai-compatible`, name = `LLM_CREDENTIAL_NAME`
from `@workbench/agents`) must be seeded — the deploy resolves the base inference
source from it.

```bash
HUB_URL=https://hub.example.com HUB_SERVICE_TOKEN='<sidecar/service token>' \
  bun run workflows:push -- --kind collateral-generation
```

`--hub-url` overrides `HUB_URL`. On success the script prints the deployed kind,
deployment id, and deploy mode (`multi-step` or `trivial`).

## Serialization constraint

A workflow is pushed as JSON, so every step agent must express its tools as
serializable **`capabilities`** (and an optional **`director`** ref), never as
inline tool factories — functions vanish through `JSON.stringify` and would
silently deploy a tool-less agent. The push script refuses any definition that
contains a function, so this fails fast rather than at runtime.

## Adding a new workflow

1. Create `workflows/<kind>/` as `@workbench/workflow-<kind>`, exporting `kind`
   and `workflow` (see `workflows/collateral-generation`).
2. `bun install` (registers the new workspace member).
3. `bun run workflows:push -- --kind <kind>`.

No hub or push-script edits are required — the push script resolves the package by
naming convention (`@workbench/workflow-<kind>`) and the hub deploy route is
workflow-agnostic.

## API client generation

These scripts are hand-written against a single endpoint. If we later emit a hub
OpenAPI spec, [`openapi-arktype`](https://github.com/alexanderguy/openapi-arktype)
can generate a typed arktype client from it instead of hand-writing REST calls —
worth adopting once more than one hub endpoint is driven from scripts.
