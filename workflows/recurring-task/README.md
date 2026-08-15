# @corbits/recurring-task-workflow

A deploy-layer placeholder, not a real agent turn. It exists so a task's
prompt+agent has an AUTOMATABLE workflow definition id the Routines picker
can offer and schedule — task-launchable definitions are conversational
(excluded from the automatable filter by construction), so there is no
other honest way for "Make this a routine" (an Inbox action on a
completed task result) to hand the create dialog a definitionId that
actually resolves in that picker's list.

## What it does — and doesn't

Its single step is never actually invoked. `apps/hub/src/routine-launcher.ts`
recognizes this workflow's asset name (`RECURRING_TASK_ASSET_NAME`,
`@corbits/workflow-catalog`) the moment a routine on it fires, and
dispatches straight through `@corbits/tasks`' `launchTask` with the
routine's stored `agent`/`prompt` trigger-field input instead of launching
this definition's folded run — the exact same launch path `POST /tasks`
uses, so the result reaches the creator's Inbox exactly like a manual
task.

The step still has to be a real, deployable definition (a valid system
prompt, at least one step) to pass asset materialization and the generic
"is this routine's definition deployed" checks every routine gets before
it fires — it is dead code in the fire path that matters, kept only so
the definition builds and deploys like any other catalog workflow.

## Usage

```ts
import {
  buildRecurringTaskWorkflow,
  serializeRecurringTaskWorkflow,
} from "@corbits/recurring-task-workflow";

const definition = buildRecurringTaskWorkflow({
  triggerAddress: "recurring-task@tenant.example",
  inferencePreferences: [{ provider: "anthropic", model: "claude-sonnet-5" }],
  turnTimeoutMs: 60_000,
});

const json = serializeRecurringTaskWorkflow(definition);
```

See [`workflows/README.md`](../README.md#status-note) for what
registration/automatable/seeded mean — this one is seeded by default for
every tenant, same as `channel-digest`.
