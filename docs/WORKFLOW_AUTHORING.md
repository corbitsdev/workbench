# Workflow authoring — portable Interchange core, Workbench as side policy

Authoring contract for workflow packages under `workflows/<kind>/`. Goal: keep
the **DAG runnable on plain Interchange** whenever possible, and keep Workbench
catalog UX, intake forms, and hub notification policy as **optional side
exports / hub policy** — not as a required mega wrapper.

Companion docs:

- [DEPLOYING_WORKFLOWS.md](./DEPLOYING_WORKFLOWS.md) — push, deploy, boot
  autopublish, deterministic-step substrate facts
- [WORKFLOWS.md](./WORKFLOWS.md) — how a run actually executes in Workbench
- [workflows/README.md](../workflows/README.md) — package layout convention

Related product decision: **CL-4312** (success inbox = result mail only) and
this issue (**CL-4332**).

## One-sentence contract

> **`workflow` (the `defineWorkflow` graph) is the portable Interchange core.
> Everything else a package exports is Workbench-facing metadata or optional
> convenience. Success that should reach a human inbox is an explicit result
> step (`mail_send` / product fan-out), not hub auto terminal-success mail.**

Do **not** introduce a `defineWorkbenchWorkflow` (or similar) that bakes hub
mailbox, terminal mail, `DISPLAY_STEPS`, intake forms, and deploy metadata into
the only supported way to define a DAG. Prefer **composition**: native
`@intx/workflow` primitives first; thin helpers only when they stay optional.

## Layer model

```
┌─────────────────────────────────────────────────────────────┐
│  Workbench hub policy (not in the package)                  │
│  · terminal failure mail (success = result mail only)       │
│  · schedule attach rules, gate agent, catalog bootstrap     │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  Side exports (optional; never required to run the graph)   │
│  · label, description                                       │
│  · DISPLAY_STEPS                                            │
│  · INTAKE_FIELDS                                            │
│  · ALLOWS_SCHEDULED_POST_INTAKE_DRIVE                       │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  DAG core — export `workflow` via defineWorkflow(...)       │
│  · Portable: action / step / awaitSignal / map              │
│  · Workbench helpers OK if they still emit StepPrimitives   │
│    (deterministicToolStep, agentStep) — see catalog below   │
└─────────────────────────────────────────────────────────────┘
```

The hub **never imports** workflow package source at runtime. Build serializes
`workflow` plus any side exports it understands into
`apps/hub/generated/workflow-defs/<kind>.json`
(`apps/hub/bin/build-workflow-defs.ts` via `loadWorkflow`). Side fields sit
**beside** `definition` so they do not churn the published-definition
fingerprint used for deploy idempotency.

## Required vs optional package exports

| Export                               | Required? | Portable?                            | Role                                                            |
| ------------------------------------ | --------- | ------------------------------------ | --------------------------------------------------------------- |
| `kind`                               | Yes       | Yes (string)                         | Stable kind id; matches directory name                          |
| `workflow`                           | Yes       | **Yes — the DAG**                    | `defineWorkflow(...)` from `@intx/workflow`                     |
| `label`                              | Optional  | Workbench catalog only               | Human title in launcher / mail subjects                         |
| `description`                        | Optional  | Workbench catalog only               | Catalog blurb                                                   |
| `DISPLAY_STEPS`                      | Optional  | Workbench catalog / run stepper only | Grouped user-facing step flow                                   |
| `INTAKE_FIELDS`                      | Optional  | Workbench attach / start form only   | First-intake form schema (CL-3509)                              |
| `ALLOWS_SCHEDULED_POST_INTAKE_DRIVE` | Optional  | Workbench scheduler only             | Opt-in for Myra-driven post-intake gates on schedules (CL-3528) |

`loadWorkflow` (`apps/hub/bin/deploy-workflow.ts`) is the authoritative reader
of these exports. Unknown exports are ignored; missing side exports are fine.

A pure Interchange consumer only needs `workflow` (and whatever tools /
handlers the steps declare). Catalog label, display groups, and intake fields
are irrelevant outside Workbench.

## Helper catalog: portable vs Workbench-only

### Portable (Interchange-native) — prefer these for the DAG body

| Primitive                                      | Package          | Notes                                                                 |
| ---------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| `defineWorkflow`                               | `@intx/workflow` | Definition root                                                       |
| `step({ agent, input?, after? })`              | `@intx/workflow` | Reasoning step with a real agent def                                  |
| `action({ handler, input?, effect?, after? })` | `@intx/workflow` | Deterministic tool/handler call — **portable default** for tool steps |
| `awaitSignal`                                  | `@intx/workflow` | HITL gate                                                             |
| `map` / other native combinators               | `@intx/workflow` | Fan-out shapes supported by Interchange                               |

**Heartbeat is the reference composition** for result-shaped success:
unattended graph → persist artifact → explicit `mail_send` via native
`action` (`workflows/heartbeat`). Success that matters is **in the DAG**, not
a hub side effect after `RunCompleted`.

### Workbench convenience helpers (optional; still emit `StepPrimitive`)

These live in `@workbench/agents` (`packages/agents/src/deterministic-step.ts`).
They are **not** required to author a runnable graph. They compile to ordinary
`step({ agent })` shapes with **Workbench tags** the Workbench sidecar invoker
interprets. On a non-Workbench Interchange deploy that does not honor those
tags, behavior differs (see tags table). Use them when the Workbench substrate
capability is what you need; prefer native `action` when you do not.

| Helper                  | Workbench-only tags / behavior                                                                                                                                                      | Prefer native when…                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deterministicToolStep` | Tags: `workbench.stepKind=deterministic-tool`, `workbench.tool`, optional `workbench.argMap`, `workbench.nonFatal`, `workbench.title`. Sidecar runs the tool with **no inference**. | You can express the call as `action({ handler })` and do not need `nonFatal` / `argMap` reshape (ActionPrimitive has no `nonFatal` today — heartbeat intake steps document this gap). |
| `agentStep`             | Thin wrapper around `step` + default inference / model prefs used by Workbench packs                                                                                                | You already have a full `defineAgent` + `step({ agent })` and do not need the sugar                                                                                                   |

**Title tag:** `workbench.title` is catalog UX only (human label in previews).
It is not required for execution.

**Do not** invent new **required** Workbench-only runtime tags for success
notification. If success needs a portable hook, put an explicit step in the
graph (or wait for an Interchange-native equivalent). Notification policy that
cannot live in the DAG belongs on the hub as product policy, not as a step
tag authors must set to get a quiet run.

### Workbench-only side exports (never part of DAG execution)

| Export / field                       | Consumer                                                       | Portable deploy impact if omitted                               |
| ------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------- |
| `label` / `description`              | Catalog, deploy meta, terminal-mail subject fallback           | None on the graph; generic kind string in UI                    |
| `DISPLAY_STEPS`                      | Embedded `displayFlow`; catalog preview + run stepper grouping | UI falls back to derived / raw step keys                        |
| `INTAKE_FIELDS`                      | Embedded `intakeFields`; schedule attach + start forms         | No first-intake form; gates still work if declared in the DAG   |
| `ALLOWS_SCHEDULED_POST_INTAKE_DRIVE` | Scheduler attach policy                                        | Kind stays off multi-gate schedule drive unless hub allowlisted |

### Hub-only policy (not package exports)

| Mechanism                                     | What it does                                                                                                                                                                             | Authoring rule                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `deliverRunTerminalMail`                      | Hub may fire **failure** mailbox rows on terminal failure (`apps/hub/src/workflow-executor/run-terminal-mail.ts`). Generic terminal-**success** mail is not a product surface (CL-4312). | **Do not rely on hub completion mail for product success.** Failure mail remains the hub breaker. |
| `notifyRunFailure` member pref                | Opt-out for failure rows (default on)                                                                                                                                                    | Leave failure to hub policy                                                                       |
| Product fan-outs (e.g. `granola_fanout_call`) | Domain-specific result delivery                                                                                                                                                          | Prefer these (or `mail_send`) for produced success                                                |

## Success notification policy (product default)

**Inbox success = result mail only** (CL-4312).

| Situation                                                                                     | What should reach the inbox                                                                                            |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Run produced something a human should see (brief, call notes, report, links)                  | Explicit **result mail** inside the workflow (`mail_send` / `action` handler) **or** a documented product fan-out tool |
| Run completed with nothing produced (discoverer found zero work, all items already processed) | **Silence** — no success row                                                                                           |
| Run failed                                                                                    | Hub **terminal-failure** mail (plain language + run link); failure breaker preserved                                   |

### Why not hub auto terminal-success mail

1. **Portability** — pure Interchange deploys have no Workbench hub completion
   mailer. A workflow that only "notifies" via hub policy is silent outside
   Workbench.
2. **Signal quality** — scheduled discoverers complete successfully on empty
   work; generic "Workflow run completed: granola-call" rows bury real output.
3. **Content bar** — result mail should carry artifact title/kind/preview and
   human links, not raw run UUIDs as the primary body.

Generic terminal-**success** mail is removed as a product surface (CL-4312):
quiet completed runs write nothing. Do not add new workflows that only "notify"
by assuming a hub completion row. Do not add a Workbench-only step tag that
means "suppress hub success mail" as the primary quiet mechanism — quiet
success is the default product stance; noisy success is an explicit result step.

### Authoring checklist for notifications

1. Decide whether a successful run has a **human-facing result**.
2. If yes: add an explicit last-mile step (`mail_send` and/or product fan-out)
   with a body worth reading. Heartbeat's `notify-prep` → `notify` is the
   pattern for polished result mail; process-granola-call / granola fan-out is
   the pattern for multi-recipient product delivery.
3. If no (discoverer / fan-out parent / no-op success): **send nothing**. Do
   not depend on hub completion mail, and do not invent a synthetic "done"
   message for empty work.
4. Failures: leave to hub terminal-failure mail unless the workflow has a
   richer failure path of its own.

## Discoverer / fan-out parents (granola-call and friends)

**Discoverer-style** workflows list work and optionally spawn child runs. They
are the main source of quiet successful completions.

Reference: `workflows/granola-call` (parent) + `workflows/process-granola-call`
(per-item child).

| Layer                          | Responsibility                                                  | Success mail?                                                                  |
| ------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Parent (`granola-call`)        | List recent items; spawn children for unprocessed work; exit    | **No** — including when `spawned.length === 0` ("quiet run")                   |
| Child (`process-granola-call`) | Produce artifacts for one item                                  | Result delivery via **product fan-out / explicit mail**, not parent completion |
| Hub terminal-success           | Not a product surface (CL-4312 removes generic completion mail) | Do not use; success = result mail only                                         |

When authoring a new discoverer:

- Keep the parent DAG small and deterministic.
- Put result content on the **child** (or a shared fan-out tool), not on a
  generic parent "completed" notice.
- Document quiet success in the package `description` (granola-call already
  says a quiet run spawns nothing).
- Do not add `mail_send` on the parent solely to say "I ran and found nothing."

The same quiet/result-mail contract applies to other watch/scan parents
(topic watch, opportunity watch, etc.): empty discovery is silence; produced
work notifies through explicit result paths.

## Patterns to copy

### 1. Portable core + explicit result mail (heartbeat)

- Native `action` for pure tool/handler steps where possible.
- `deterministicToolStep` only where Workbench tags add real capability
  (`nonFatal` intake sources).
- Persist artifact, then `mail_send` with a prepared body.
- Optional `DISPLAY_STEPS` for catalog UX only.

### 2. Discoverer parent (granola-call)

- DAG: discover → spawn.
- Side exports: `label`, `description`, `DISPLAY_STEPS`, light `INTAKE_FIELDS`.
- No success mail on the parent.
- Children own artifacts + fan-out.

### 3. HITL collateral pack (pain-point, gamma, …)

- Mix of `deterministicToolStep`, `agentStep`, `awaitSignal`.
- `INTAKE_FIELDS` / `DISPLAY_STEPS` for Workbench UX.
- Deliverables are artifacts (and optional explicit mail); do not treat hub
  completion mail as the deliverable.

## Anti-patterns

| Anti-pattern                                                                           | Why                                                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Mega `defineWorkbenchWorkflow({ dag, display, intake, terminalMail })` as the only API | Locks authoring to Workbench; fights portability                                      |
| Success notification only via hub terminal-success mail                                | Non-portable; spammy for quiet runs; weak content                                     |
| Required new `workbench.*` tag just to suppress success mail                           | Encodes product policy as a runtime tag; prefer default quiet + explicit result steps |
| Putting catalog-only data inside step agents "so the runtime has it"                   | Side exports already serialize beside the def; keep the DAG clean                     |
| Importing workflow packages from hub/web app code                                      | Hub is definition-agnostic; use embedded JSON / APIs                                  |

## Thin helpers (if you add one later)

Any new helper must satisfy **all** of:

1. **Optional** — authors can still write pure `@intx/workflow` without it.
2. **Not required to run the DAG** — no new mandatory Workbench runtime
   dependency for success paths that Interchange cannot express.
3. **Lives in a Workbench package** (`@workbench/*`) when it is Workbench-
   specific; never force it into `interchange/`.
4. **Documents** whether it emits portable primitives, Workbench tags, or
   catalog-only data.

Docs-only guidance is preferred over new code unless a helper removes
repeated, error-prone boilerplate without narrowing the supported path.

## Where serialization picks side exports up

| Stage       | What runs                                                                     |
| ----------- | ----------------------------------------------------------------------------- |
| Author      | Export `kind` + `workflow` (+ optional side exports) from `workflows/<kind>/` |
| Build       | `bun run build:workflow-defs` → `EmbeddedWorkflowDef` JSON                    |
| Boot / push | Hub publishes `definition`; catalog stores label/display/intake siblings      |
| Run         | Sidecar executes the graph only — side exports do not re-enter the child      |

Gate shape (`requiresIntake`, `humanGateCount`) is **derived from the
definition** at build time (`deriveWorkflowGateInfo`), not a hand-written side
export — keep intake as real `awaitSignal` steps in the DAG when the graph
needs them.

## Summary for PR / review

When reviewing a new or changed workflow package, ask:

1. Would this DAG still make sense as pure `@intx/workflow` on a non-Workbench
   Interchange deploy?
2. Are Workbench UX concerns only in side exports?
3. Is human-visible success an explicit result mail / fan-out, or are we
   leaning on hub completion mail?
4. If this is a discoverer, is empty success silent?

If all four hold, the package matches this contract.
