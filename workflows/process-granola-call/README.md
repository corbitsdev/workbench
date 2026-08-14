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
3. verifying that draft against the transcript, then calling
   `process_granola_call_finalize` (`./src/finalize-tool.ts`) once with
   `status: "notes"` to persist the final call-notes artifact.

If it cannot fetch the call's transcript — no Granola connection, an
unknown call id, an empty transcript — it does not fabricate call notes.
Instead it calls the same finalize tool once with `status: "no-data"`: a
plain-language reason grounded in what actually happened, and next
steps a human can check, starting with the `granola` connector's
connection status for this workspace
(`packages/connections/src/registry.ts`). That failure is scoped to the
one run: because the parent spawns one run per call, one bad transcript
never blocks the rest of a batch — and the human still gets something
useful instead of a bare "nothing to report" line.

Both finalize calls are approval-gated (`approval: "ask"`, the
platform's native tool-approval gate — see
`workflows/pain-point-collateral/src/finalize-tool.ts`'s header comment
for the exact suspend/resume mechanics, identical here) and, once
approved, persist a real Library artifact via
`createWorkflowArtifact` (`./src/artifact-client.ts`, CL-6000), which
becomes a chip through `packages/chat/src/artifact-delivery.ts`. A
denied call gets a calm, plain reply that nothing was published, never
an error.

**Teaching-artifact kind**: `status` (`"notes"` | `"no-data"`), already
the structural argument that picks which of the two content shapes to
build, also picks the persisted artifact's `kind`: `"text"` for real
call notes, `"status-note"` for the no-data teaching payload — decided
by `buildArtifactPayload` from `args.status`, never left to free text.
`"status-note"` is the one teaching-artifact kind shared by every
workflow in this catalog, so the Library's kind badge always reads
"Status note" for a no-data run, regardless of which workflow made it.

## Current limits (read before deploying)

One platform-level gap remains, shared with the parent
(`@corbits/granola-call-workflow`'s README): no shipped host resolves
`@intx/workflow`'s `action` primitive, so nothing can spawn this
workflow programmatically yet — it must be started by hand (or by
future host machinery) with a call id until that lands. Separately,
`corbitsdev/granola-tools` still needs to be published somewhere this
host's tool loader can resolve it from before a real transcript fetch
succeeds; until an operator does that, every run's finalize call
reports `status: "no-data"` honestly rather than fabricating notes.

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

See [`workflows/README.md`](../README.md#status-note) for what
registration/automatable/seeded mean — this one is spawned only by
`granola-call`, so it's `automatable: false` and never seeded on its own.
