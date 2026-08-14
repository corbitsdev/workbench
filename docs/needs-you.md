# Needs you

Approval is "needs you." When a running workflow parks on a human decision,
that pause is Interchange's own native state — an `approval` row backed by a
`signal_correlation` row, produced by `AwaitSignalPrimitive` — not a second
concept this repo invents alongside it. This document describes the one
piece Interchange's approval machinery doesn't carry on its own: turning a
pending approval into something a person can actually read.

## What's native, unchanged

Everything about deciding an approval is Interchange's, consumed as-is:

- `GET /api/tenants/:tenantId/approvals` lists a tenant's pending approvals.
- `POST /api/tenants/:tenantId/approvals/:id/approve` and `.../reject`
  resolve one. Both run inside a single transaction that claims the
  approval's `signal_correlation` row under a `resolved_at IS NULL` guard
  and only then flips the approval's status — so two concurrent decisions
  (two clicks, two people) can never both land: the second finds nothing
  left to claim and is told the approval is already resolved.
- Every resolve is authorized against the same grant an approver has always
  needed: `approval:<deploymentId>` (or the tenant-wide `approval:*`),
  checked server-side before the transaction runs, never left to the
  interface to hide a button.

None of that changed. `@corbits/approvals` never creates, claims, or
resolves an approval — it only reads.

## What's new: resolving names, not ids

An `approval` row only carries what it needs to authorize and resume: a
`deploymentId`, a `runId`, an `agentAddress` with an instance id baked into
it. None of that is something a person should have to read. `GET
/api/tenants/:tenantId/approvals/needs-you` (`@corbits/approvals`,
`packages/approvals`) reads the same pending rows the native list route
does and resolves each one's real name before it ever reaches a client:

- `runId -> workflow_run.definitionId -> workflow_definition.name` for
  which agent is asking.
- `tenantId -> tenant.name` for which bench the ask is in.

The result is a small, display-only view model — an agent name, a bench
name, the tool's headline, its arguments, nothing else — gated by the exact
same `approval:*` / `resolve` grant the native list route requires. A
principal without that grant gets a `403`, not an empty list dressed up as
"nothing pending."

## Where it shows up

There is no "Approvals" nav row and no dedicated Approvals page. Needs-you
approvals surface through the Activity band (`ActivityBand`,
`apps/web/src/shell/activity-band.tsx`) — a permanent section of the
contextual panel shown on every page, the same slot pins uses, not something
scoped to one route. It reads this same `needs-you` endpoint, renders each
pending request as "`<agent name>` in `<bench name>`" through
`ApprovalCard` (never a raw agent address or run id), and posts approve/
reject straight to Interchange's native
`/api/tenants/:tenantId/approvals/:id/{approve,reject}` routes — this
package only ever supplies the names. Approve only offers scope "once" (the
hub rejects "always" with a 400); reject collects an optional message
through a confirm dialog.

The band's heading carries a live count as a `Badge` next to "Activity" when
there is anything pending, and the whole band hides — no hollow empty state
— once it resolves to zero. It stays mounted while loading, or once items
arrive, so a pending approval can be resolved without leaving whatever page
the user is on.

## What this deliberately does not add

No new "gate" table, no parallel resolution path, no reimplementation of
`claimTerminal` or the approve/reject transaction. Mail-based delivery
(notifying a human's inbox the moment an approval is created, rather than
this page polling for it) and reply-to-resume are real, valuable follow-ups
that build on this same `approval` row — neither is part of this change.
