# Workflow definition projection

Notes on `@corbits/workflows`'s `definition-projection.ts`, the pure reader
that turns an already-resolved inert wire projection into a `FoldedBody`.

## Why this exists

There's no hub-side row to read a launch body back off of. This module is
the pure half: the schema-validated reader for anything holding a
projection value from elsewhere (chat, in particular). Nothing here queries
a database.

`grantRequirements` is deliberately excluded from the projection: it does
not survive the live-to-inert projector and lives instead on the
`workflow_definition.grant_requirements` column, so callers pass it in
alongside the projection rather than reading it off.

## Step shapes

An inert projection's launch step comes in two shapes: a bare `step` (the
conversational case) or an `onTrigger` section whose inline body carries the
one agent-bearing step that answers each turn. `extractAgentBearingStep`
reads through either shape with one reader, so neither call site duplicates
the other's parsing.

## Why multi-step definitions are rejected

The launch target (`@corbits/agent-runtime`'s `AgentRuntimeConfig`) renders
exactly one `systemPrompt` into one mailbox-triggered turn — it has no
notion of step order. Reading past `stepOrder[0]` would silently drop every
later step's behavior rather than run it, so `MultiStepFoldUnsupportedError`
is thrown instead. Genuine multi-step launch needs a different deploy front
(Interchange's native workflow-run trigger, `@intx/workflow-host`'s DAG
supervisor) than this module provides.
