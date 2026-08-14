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
- when a run starts no `process-granola-call` children — no way to
  reach Granola at all, or Granola connected but nothing new to
  process — calling `granola_call_report_status`
  (`./src/finalize-tool.ts`) once to persist a real, chip-visible
  status artifact: why nothing started, how many calls were actually
  examined, and what to check next (starting with the `granola`
  connector's connection status,
  `packages/connections/src/registry.ts`). Never inventing call counts
  or notes. That tool is not approval-gated — a status report has
  nothing for a human to confirm, only what actually happened — and
  persists via `createWorkflowArtifact` (`./src/artifact-client.ts`,
  CL-6000), the same sanctioned workflow-artifacts surface
  `process-granola-call`'s finalize tool uses.

**Teaching-artifact kind**: `buildStatusArtifactPayload` always persists
with `kind: "status-note"` — this tool only ever produces a status
report, never a real deliverable, so there is no competing shape to
confuse it with, but the value still matches the one teaching-artifact
kind shared by every workflow in this catalog, so the Library's kind
badge always reads "Status note" here too, not a bare "Text" that would
look identical to a real deliverable elsewhere.

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
2. **`@corbits/granola-tools` is not published anywhere this host's tool
   loader (`@intx/tool-packaging`) can resolve it from by default.** This
   definition now pins it (`GRANOLA_CALL_TOOL_PACKAGE_PINS`, CL-5999),
   but a pin only resolves once an operator seeds it into a registry the
   host's `toolPackageRegistries` config reaches — either npmjs, or a
   `package-registry` asset for the `@corbits` scope (see
   `apps/hub/src/index.ts`'s `CORBITS_TOOLS_REGISTRY` wiring).

Until both land, a deployment of this definition is an honest
placeholder: until an operator publishes the pin, every run persists a
status artifact saying Granola is not connected rather than fabricating
a call list. That is deliberate — see the "no fallbacks" and "parse at
every trust boundary" rules in `AGENTS.md`; a workflow that quietly
returns fake data on a broken dependency is worse than one that says so.

Persisting that honest status as a real Library artifact (CL-6029) does
not depend on either gap above: it is this workflow's own finalize step,
independent of spawning children or reaching Granola. Only the
pipeline's actual fan-out — starting real `process-granola-call`
children — waits on gap #1.

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
