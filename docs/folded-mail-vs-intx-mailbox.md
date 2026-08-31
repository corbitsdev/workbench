# `folded-runs/src/mail.ts` vs `@intx/mailbox`

Analysis for CL-7276. Read against the vendored pin `a8bc06ae`.

## The claim under test

CL-7276 was filed on the claim that `folded-runs`' mail layer duplicates published
`@intx/mailbox` surface — noting that `executeSearch` and `executeThread` have zero
callers in this repo — and that `listFoldedMail`'s hand-rolled keyset pagination
should be routed through the native package.

**That claim is wrong, and the zero-caller signal was misleading.** The two operate
on different storage planes. There is nothing to route.

## The two planes

|                     | `folded-runs/src/mail.ts`                                               | `@intx/mailbox`                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Backing store       | `session_mail`, a **Postgres** table (`@intx/db/schema/messages.ts:71`) | UID/MODSEQ message store, IMAP-shaped                                                                                           |
| Backings that exist | —                                                                       | `createInMemoryMailboxStore`; `createSubstrateMailboxStore` (`@intx/workflow-host`), writing into the workflow-run **git repo** |
| Postgres dependency | drizzle + `@intx/db`                                                    | **none** — deps are `@intx/crypto`, `@intx/mime`, `@intx/types`, `arktype`                                                      |
| Plane               | Hub                                                                     | Sidecar / run substrate                                                                                                         |
| Addressing          | `(sessionId, createdAt, id)` keyset                                     | `uid`, `modseq`, `uidValidity`                                                                                                  |

`@intx/mailbox` has no Postgres backing and no way to acquire one without a new
adapter. `executeSearch`/`executeThread` take a `MailboxStore`, which
`session_mail` is not and cannot cheaply become — `MailboxStore` is a synchronous
in-memory interface exposing `messages`, `uidNext` and `highestModSeq` as readonly
properties.

So the hand-rolled keyset walk in `listFoldedMail` is not a reimplementation of
`executeSearch`. It is a Postgres query against a Postgres table, and the native
functions could not serve it.

## Why the zero-caller signal was misleading

`executeSearch` and `executeThread` having no callers in this repo is real, but it
means the _sidecar-side_ mailbox surface is unused here — not that we reimplemented
it. Those functions are consumed inside `@intx/workflow-host`'s substrate mailbox,
which the vendored sidecar runs. The hub never holds a `MailboxStore`.

This is worth recording as a caution for the parent audit (CL-7257): "native export
with zero callers" is a lead, not a finding. Two of the five sub-issues filed off
that signal have now been disproved by reading the backing store.

## What the send path actually shares

`sendFoldedMail` already composes native primitives rather than reimplementing
them — `@intx/mime`'s `parseMailToEmail` here, and `assembleMessage` /
`assembleSignedContent` / `createDetachedSignatureFromProvider` in the sibling
delivery paths. MIME assembly and signing are not duplicated.

The retry wrapper `sendFoldedMailWithRetry` has no native counterpart and should
stay. Its hardening is load-bearing: see the module header of
`packages/webhook-triggers/src/launch.ts` on why a delivery-failed mail must not
throw past an already-202'd webhook route, or a sender retry mints a second run for
one event.

## `POST /workflows/:runId/mail`

Native, and real (`vendor/intx/hub-api/src/routes/workflows.ts:846`), but it is an
HTTP route requiring a `workflow-run:<id>` `manage` grant. The hub calling its own
route in-process to write a row it already owns would add an authz round-trip and a
serialization hop to a direct write. Not recommended.

## Conclusion

No change recommended. CL-7276 should be closed as "different storage planes".

The genuine version of this work is **CL-7103** (adopt Interchange per-run mailboxes
and threaded mail in workbench chat). That is a real migration — moving hub chat
onto the run-substrate mailbox — with a product decision and a data migration
attached. It is not a deduplication, and this ticket should not be confused with it.

## Not verified

- Whether `session_mail` could be exposed _as_ a `MailboxStore` adapter cheaply
  enough to be worth it under CL-7103. The interface's synchronous readonly
  `messages` array suggests not, but that is CL-7103's question to answer.
