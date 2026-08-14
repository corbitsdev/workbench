# @corbits/granola-call-workflow

The parent half of the Granola call-notes pipeline (CL-5998, ported from
`gtm-workbench`'s `workflows/granola-call`). Meant to run on a recurring
Routine schedule — hourly or daily both work — it polls Granola for
recent calls and starts one `process-granola-call` run per call that has
no published call-notes artifact yet.

## What it does

One step, one agent. The system prompt commits it to:

- looking at up to `DEFAULT_CALL_LIMIT` (10) recent calls per run unless
  told otherwise,
- never reprocessing a call that already has a published call-notes
  artifact (idempotent — a quiet run starts nothing),
- skipping a call whose transcript is missing or unreadable rather than
  failing the whole run,
- saying plainly, in one sentence, when it has no way to reach Granola
  at all — never inventing call counts or notes.

## Sensible defaults

- **Schedule:** attach an hourly or daily Routine. A tighter schedule
  than hourly buys little (new calls accumulate between polls anyway)
  and a daily poll is enough for most workspaces.
- **Call limit:** 10 per run, matching the source repo's default and
  bounding a poll's cost even on a backlog.

## Current limits (read before deploying)

This port keeps the shape of every other workflow in this catalog
(`step`/`defineAgent`, mail-triggered, tools arrive as packages on the
deploy) rather than inventing new primitives. Two real gaps stand
between this definition and the pipeline's actual behavior, both
platform-level, not specific to Granola:

1. **No spawn-child mechanism.** Nothing in this host lets a run start
   other runs programmatically yet. `@intx/workflow`'s `action`
   primitive exists but no shipped host wires the `invokeAction`
   callback it needs (see `@corbits/heartbeat-workflow`'s README for the
   same finding). Fanning out into per-call `process-granola-call` runs
   needs that wired first.
2. **No Granola tool access.** `corbitsdev/granola-tools` is not
   published anywhere this host's tool loader (`@intx/tool-packaging`,
   resolving against `npmjs` by default) can reach it from, and no
   production workflow builder in this repo threads tool-package pins
   onto a definition at all yet (`docs/AGENTS-PAGE.md`).

Until both land, a deployment of this definition is an honest
placeholder: its agent has no tools, so every run replies that Granola
is not connected rather than fabricating a call list. That is
deliberate — see the "no fallbacks" and "parse at every trust boundary"
rules in `AGENTS.md`; a workflow that quietly returns fake data on a
broken dependency is worse than one that says so.

## Usage

```ts
import {
  buildGranolaCallWorkflow,
  serializeGranolaCallWorkflow,
} from "@corbits/granola-call-workflow";

const definition = buildGranolaCallWorkflow({
  triggerAddress: "granola-call@tenant.example",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 120_000,
});

const json = serializeGranolaCallWorkflow(definition);
```

Registered in `@corbits/workflow-catalog` as `granola-call`
(`automatable: true`), so it is offered by the Routines picker. Not
seeded into `DEFAULT_WORKFLOWS` — Granola is not connected for every
tenant, so this is opt-in per workspace rather than provisioned on
every signup.
