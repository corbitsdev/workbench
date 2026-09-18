# Agent definition status lifecycle

Notes on `@corbits/agent-directory`'s `routes.ts`, `PUT /:definitionId/status`.

## What it does

Archive and restore is the whole lifecycle a person controls from the agent
detail page. `stopped` drops a definition out of every launchable listing
while leaving the row, its asset, and its git history untouched — which is
what makes the same route, with `deployed`, a restore rather than a
re-create.

## The invariant this route relies on

Two other writers of `workflow_definition.status` exist in this build:

1. Row creation. `ensureWorkflowDefinitionForAsset` inserts with the column
   default (`deployed`) under `onConflictDoNothing` on `(assetId,
   wireHash)`, so re-deploying the same definition body over an archived
   row is a no-op and can never silently un-archive it. Editing an agent
   through this package's own routes only repopulates the asset and never
   re-projects a definition row at all.
2. `apps/hub`'s `undeployAgentDefinition`, which writes `stopped` — the
   same direction as archiving, so the two can't fight.

## A known hole

The one way an archived agent reappears as launchable is a deploy of a
changed body over the same asset: a new `wireHash` misses the unique
constraint and inserts a second definition row, `deployed` by default,
beside the archived one. Nothing in this build takes that path for a
hand-authored agent — only `createAgentDefinitionCore` and Interchange's own
selector deploys call the ensure — but it's a real hole in the
status-as-lifecycle model, not a hypothetical one.
