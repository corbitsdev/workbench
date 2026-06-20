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
- **Push**: the push script imports `@workbench/workflow-<kind>`, serializes its
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

Deploy is an **operator action**. There are two authorized paths, both resolving
to the same deploy logic:

- **Session path (operators) — `POST /api/v1/workflows/deploy`.** Gated by a
  valid better-auth session **plus** the native Interchange grant check: the
  caller's principal must satisfy `authorize(... "workflow:*", "create")`. The
  global **owner** role's `*:*` grant satisfies this, so an owner deploys a
  workflow the same way it creates an agent or a credential (`agent:*`/`create`,
  `credential:*`/`create`). This is the default the admin CLI uses, via the
  operator's `SESSION_TOKEN`.
- **Service path (machine/unattended) — `POST /api/internal/workflows/deploy`.**
  Gated by the hub **service token** (`Authorization: Bearer <SIDECAR_TOKEN>`),
  the same gate the other `/api/internal` routes use. For callers with no session.

This matters because the orchestrator auto-approves the grants the posted
definition declares — so deploy must be restricted to a trusted operator (an
owner-grant holder) or a service-token holder. A plain member session is denied
with 403.

## Pushing a workflow

The hub and sidecar must be running on the **same interchange pin**, and the
tenant LLM credential (provider `openai-compatible`, name = `LLM_CREDENTIAL_NAME`
from `@workbench/agents`) must be seeded — the deploy resolves the base inference
source from it.

Run the admin CLI (`bun run admin` locally, or `bun run admin:staging` /
`bun run admin:production` from `apps/hub`): sign in, select the target tenant,
then choose the **Workflows** resource → **Push (deploy) a workflow**. The CLI
discovers the available workflow kinds from `workflows/*` and lists them — pick
one, no need to know the kind by heart. The selected tenant is threaded
automatically. On success the CLI prints the deployed kind, deployment id, and
deploy mode (`multi-step` or `trivial`). See [ADMIN_CLI.md](./ADMIN_CLI.md) for
the CLI details.

## Serialization constraint

A workflow is pushed as JSON, so every step agent must express its tools as
serializable **`capabilities`** (and an optional **`director`** ref), never as
inline tool factories — functions vanish through `JSON.stringify` and would
silently deploy a tool-less agent. The push script refuses any definition that
contains a function, so this fails fast rather than at runtime.

## Adding a new workflow

1. Create `workflows/<kind>/` as `@workbench/workflow-<kind>`, exporting `kind`
   and `workflow` (see `workflows/pain-point-collateral`).
2. `bun install` (registers the new workspace member).
3. Push it via the admin CLI's **Workflows → Push (deploy) a workflow**; the new
   kind appears in the discovered list automatically.

No hub or push-script edits are required — the push script resolves the package by
naming convention (`@workbench/workflow-<kind>`) and the hub deploy route is
workflow-agnostic.

## Deterministic (non-inference) steps

Not every step should be an LLM agent. A step that just calls a tool/API, fetches
data, or collects human input must NOT burn an inference call. **Only
genuine-reasoning steps are agents.** Three patterns cover the rest:

1. **Deterministic tool call** — use `deterministicToolStep({ id, tool, input?, after? })`
   from `@workbench/agents`. It builds a placeholder agent (`inference: { sources: [] }`,
   the reactor never runs) tagged `workbench.stepKind: 'deterministic-tool'` +
   `workbench.tool: '<name>'`; the tool stays in `capabilities` so its grants +
   package manifest are pinned at deploy. The sidecar's `createSidecarStepInvoker`
   dispatches the tagged step to `runDeterministicToolStep`, which invokes the tool
   runner directly — no `createAgent`, no `agent.send`, no inference. The step's
   resolved `input` is passed verbatim as the tool's arguments (no `input` → `{}`).
   Example: `render: deterministicToolStep({ id, tool: 'gamma_create_from_template', input })`.

2. **Fetch + human select** — `deterministicToolStep` to fetch options →
   `awaitSignal` for the pick → `deterministicToolStep` to fetch the chosen item:

   ```ts
   intake: deterministicToolStep({ id, tool: 'granola_list_notes', input: { literal: {} } }),
   select: awaitSignal({ name: 'note-selection', after: ['intake'] }),
   fetch:  deterministicToolStep({ id, tool: 'granola_get_note',
                                   input: { from: 'steps.select.output' }, after: ['select'] }),
   ```

   The panel renders the list from `steps.intake.output` and fires
   `onSignal('note-selection', { noteId })`; the select step's output IS that payload.

3. **Human input form** — for pure data collection (a URL, a prompt, an uploaded
   file parsed client-side), use `awaitSignal({ name: '<step>' })` as the step (NO
   agent, NO tool). The panel renders a form and fires `onSignal('<step>', {...})`.

### Substrate facts authors must know

- **Step output shapes differ by kind.** An agent step's output is `{ reply, turn }`.
  A `deterministicToolStep`'s output is the `ToolResult` envelope `{ callId, content }`
  (string-kind tools put JSON in `content` — decode it in the panel). An `awaitSignal`
  step's output is the received **signal payload**, addressable as `steps.<id>.output`.
- **Pass data with explicit `input` selectors.** A step with no `input` selector
  receives `null`. Selectors: `{ from: 'steps.<id>.output.path' }`, `{ from: 'trigger.payload' }`,
  `{ project, fields }`, `{ merge: [...] }`, `{ literal: ... }`.
- **`awaitSignal` cannot take an `input` selector** — only `step`/`childWorkflow` do.
  A review/selection gate's panel reads the prior step's output directly.

### Current limitations (why some "deterministic" steps stay agents)

The selector DSL has **no rename/templating selector** (`project` selects existing
field names; it cannot map `steps.generate.output.reply` → a field named `prompt`),
and there is **no `map` + deterministic-dispatch** path. So a step whose tool args
must be reshaped from an agent's free-text output, or that must write one artifact
per item, cannot be deterministic yet and remains an agent that bridges the reshape:
**gamma `render`** (`gamma_create_from_template` needs a `prompt` built from the
generate agent's output) and **ab-compare `persist`** (one artifact per variant,
and `content` must be a string rendered from structured output). A reshaping/templating
selector or a `map`-aware deterministic dispatch would let both become deterministic.

## API client generation

The hub now serves a `GET /openapi.json` spec, and `openapi-arktype` is vendored
as `@workbench/openapi-arktype` (`packages/openapi-arktype/`). It generates
arktype validators from that spec; the admin CLI uses its `createClient({ url })`
runtime to drive hub resources discovered from the live spec rather than
hand-writing REST calls.
