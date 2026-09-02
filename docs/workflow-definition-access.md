# `workflow_definition` access in Workbench

Analysis for CL-7275. Read against the vendored pin `a8bc06ae`.

## The finding

`workflow_definition` is an Interchange-owned table. The pin ships
`createWorkflowDefinitionStore` (`vendor/intx/db/src/workflow-definition-store.ts`)
to read it, and that store has **zero** callers here. Meanwhile **41 direct drizzle
queries** hit `workflowDefinition` / `workflowDefinitionVersion` across 14 non-test
files.

## Why the store is bypassed

Not laziness. Its whole surface is the `(assetId, wireHash)` identity selector,
`loadFrozenGrantSnapshot`, `loadFrozenWireProjection`, and `rollback`. The two
`loadFrozen*` helpers **are** used (2 and 6 call sites) — callers reach for the
store when it fits. It simply has no by-id, by-name, by-tenant or by-asset read,
and no update path.

## What the 41 sites actually need

| Category  | Count | Shape                                           |
| --------- | ----- | ----------------------------------------------- |
| by-id     | 26    | `(definitionId, tenantId)`                      |
| by-tenant | 6     | every deployed definition for a tenant          |
| by-name   | 5     | `(name, tenantId[, status])`                    |
| by-asset  | 2     | every definition sharing an asset, newest-first |
| update    | 2     | patch `description` / `status`                  |

Spread: `packages/agent-directory` (7 files), `apps/hub/src/index.ts` (12 sites),
`packages/chat/src/platform-adapter.ts` (7), plus `folded-runs`,
`folded-run-one-shot`, `webhook-triggers`, `evals`,
`routine-launcher`, `skills-mount`.

## What a prototype migration surfaced

A prototype routed five callers (one per category) through a widened store. Doing
so exposed a second-order problem: the store runs rows through
`parseWorkflowDefinitionRow`, which validates the full row shape — status enum,
jsonb columns. Several existing fake-db fixtures stubbed only two or three fields
and failed immediately.

Those fixtures were asserting against row shapes the database cannot produce. The
hand-rolled queries are not merely duplicative; they let unrealistic test doubles
pass. That is the strongest argument for routing these call sites somewhere typed.

## Why the prototype is not this PR

The prototype widened the store **inside** `vendor/intx/db`. That is an edit within
a vendored tree, and it carries re-pin tax: every line must be hand-reapplied at
each future pin (CL-7107), and it grows the vendored delta rather than shrinking
our own re-creation. Interchange origin/main is a read-only reference we vendor or
tag from — the widening cannot go anywhere else, so it has to live somewhere that
survives a re-pin cleanly.

The prototype is preserved on `cl-7275-vendor-edit-archive` (`8a6c9901`) for
reference. It should not merge in that shape.

## Options

1. **A thin `@corbits/*` wrapper** over the native store's existing surface, adding
   the five reads above. Zero edits to `vendor/intx/db`, survives a re-pin, gets
   callers onto `parseWorkflowDefinitionRow`. Costs one small package we own.
2. **Leave the call sites alone** until a re-pin brings a wider native surface. No
   new code and no tax, but the fixture problem above persists.

Undecided. Option 2 is the smaller re-creation and matches "use as much of the pin
as possible, re-create as little as possible"; option 1 buys type safety at the
call sites now.

## Consequence for the parent check (CL-7257)

A `check:*` failing on direct `workflow_definition` access cannot ship before one of
the options above lands. Today it would fail 41 times with no correct alternative
to route to — a debt ledger, not enforcement.
