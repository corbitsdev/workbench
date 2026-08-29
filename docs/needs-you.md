# Needs you

Approval is "needs you." When a running workflow parks on a human decision,
that pause is Interchange's own native state — an `approval` row backed by a
`signal_correlation` row, produced by `AwaitSignalPrimitive` — not a second
concept this repo invents alongside it. This document describes how a
pending approval becomes something a person can read and act on, entirely
through the platform's own routes.

## What's native, unchanged

Everything about reading and deciding an approval is Interchange's,
consumed as-is:

- `GET /api/tenants/:tenantId/approvals` lists a tenant's pending
  approvals; each row carries the tool snapshot, its arguments, the run it
  came from, and a status.
- `GET /api/tenants/:tenantId/approvals/:approvalId` reads one, in any
  status, so a card can render a terminal state after the fact. It is
  gated on the same grant approve and reject require, so a refusal here is
  proof the viewer cannot resolve it; a foreign id reads as `404`, never a
  `403` that would confirm it exists.
- `POST /api/tenants/:tenantId/approvals/:approvalId/approve` and
  `.../reject` resolve one. Both run inside a single transaction that
  claims the approval's `signal_correlation` row under a `resolved_at IS
NULL` guard and only then flips the approval's status — so two
  concurrent decisions (two clicks, two people) can never both land: the
  second finds nothing left to claim and is told the approval is already
  resolved.
- `GET /api/tenants/:tenantId/runs/:runId` returns the run view, whose
  `definitionName` is the display name of the agent that is asking.

There is no sibling read on the hub. Nothing in this repo creates, claims,
or resolves an approval.

## Names, not ids

An `approval` row carries only what it needs to authorize and resume: a
`runId`, an `agentAddress` with an instance id baked into it. None of that
is something a person should have to read. `apps/web/src/pending-approvals.ts`
is the one composer that turns those rows into the display model every
approval surface renders:

- the run view's `definitionName`, read once per distinct run and cached, is
  which agent is asking;
- the account's own membership (`GET /api/me/principals` → `tenantName`) is
  which bench the ask is in;
- `headlineFor` (`@corbits/approvals/headline`) turns the tool snapshot into
  the line a person reads — the tool's own description, plus the call's
  `title` argument when it carries one.

Not one field on that model holds an identifier. When the naming read is
refused — a per-deployment approver can resolve an approval without holding
the read grant on its run — the approval is still shown, with the asker
unnamed: a blocking decision must never be hidden because its label was
unavailable.

## Where it shows up

There is no "Approvals" nav row and no dedicated Approvals page. Pending
approvals surface in three places, all reading the composer above:

- the shell's top bar chip ("N waiting on you", or "All caught up") and the
  second column's signal above the conversation list;
- Mission Control's "Needs you" panel, which approves or denies inline and
  invalidates the same query key the chat card does, so both update at once;
- a workbench's Timeline, where an approval takes its place on the
  wall-clock spine.

The in-chat approve card (`@corbits/chat-ui`) reads one approval's live
status through the same composer and posts approve/reject straight to the
native routes. Approve only offers scope "once" (the hub rejects "always"
with a 400); reject collects an optional message through a confirm dialog.

A refused list read is shown as a failure to load, never as an empty
"nothing pending" — a person who cannot see the queue is told so.

## What this deliberately does not add

No new "gate" table, no parallel resolution path, no reimplementation of
`claimTerminal` or the approve/reject transaction, and no read route
mirroring one the platform already serves. `@corbits/approvals` keeps only
what the platform has no reason to own: the grant-allowance gate that
auto-approves a call an existing grant already covers, and the pure
headline builder. Mail-based delivery (notifying a human's inbox the moment
an approval is created, rather than a page polling for it) and
reply-to-resume are real, valuable follow-ups that build on this same
`approval` row — neither is part of this change.
