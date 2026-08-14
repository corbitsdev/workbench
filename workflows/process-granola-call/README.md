# @corbits/process-granola-call-workflow

The child half of the Granola call-notes pipeline (CL-5998, ported from
`gtm-workbench`'s `workflows/process-granola-call`). One run processes
exactly one Granola call. It is spawned by `@corbits/granola-call-workflow`,
never scheduled or invoked directly — see `automatable: false` in this
package's `corbits.workflow` block.

## What it does

One step, one agent. The system prompt commits it to, per call:

1. fetching the transcript and saving it as a raw transcript artifact,
2. extracting working notes with exactly five sections — Participants,
   Summary, Pain points, Decisions, Action items — grounded in the
   transcript (quoted or closely paraphrased, "None noted" where a
   section is empty, never invented),
3. verifying that draft against the transcript and publishing the final
   call-notes artifact with the same five sections.

If it cannot fetch the call's transcript — no Granola connection, an
unknown note id, an empty transcript — it says so plainly in one
sentence and does not publish a call-notes artifact for that call. That
failure is scoped to the one run: because the parent spawns one run per
call, one bad transcript never blocks the rest of a batch.

## Current limits (read before deploying)

Same two platform-level gaps as the parent
(`@corbits/granola-call-workflow`'s README): no shipped host resolves
`@intx/workflow`'s `action` primitive, so nothing can spawn this
workflow programmatically yet, and `corbitsdev/granola-tools` is not
published anywhere this host's tool loader can resolve it from. Until
both land, this definition's agent has no tools, so it honestly reports
that it cannot reach Granola or the call it was asked about rather than
fabricating notes for a transcript it never read.

## Delivery design

Once real Granola access and a spawn mechanism land, the parent's own
run-summary reply is the natural place for a structured delivery — a
`steps` block (one row per call: queued / done / error) or a `metrics`
block (calls processed, calls skipped as already-published, calls
failed) alongside the plain-text summary line, using the block
vocabulary `packages/chat/src/blocks.ts` already defines
(`StepsBlockData`, `MetricsBlockData`). That is future work: today an
agent's reply is plain text only — no production caller in this repo
authors a `BlockPart` from a workflow step's own output (the one
precedent, `packages/chat/src/settings-control.ts`, is non-agent
platform code) — so this definition does not fabricate block usage it
cannot yet produce.

## Usage

```ts
import {
  buildProcessGranolaCallWorkflow,
  serializeProcessGranolaCallWorkflow,
} from "@corbits/process-granola-call-workflow";

const definition = buildProcessGranolaCallWorkflow({
  triggerAddress: "process-granola-call@tenant.example",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 300_000,
});

const json = serializeProcessGranolaCallWorkflow(definition);
```

A transcript-plus-extraction-plus-verification pass over a long call
needs more headroom than the catalog's shortest steps — size
`turnTimeoutMs` accordingly (the example above gives it five minutes).

Registered in `@corbits/workflow-catalog` as `process-granola-call`
(`automatable: false`), so it never appears in the Routines picker.
