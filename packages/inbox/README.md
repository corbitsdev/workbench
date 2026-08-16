# @corbits/inbox

Workbench's product inbox over `@corbits/mailbox`: projects raw mailbox
messages into three product groups (action, mention, delivery), the
mark-all-read / clear-done bulk rules, and the hub routes
(`createInboxRoutes`) mounted at `/api/tenants/:tenantId/inbox` — server-side,
backed by `@corbits/mailbox`, `@corbits/notify`, and `@intx/hub-api`.

## `/client` subpath contract

`@corbits/inbox/client` (`src/client.ts`) is a browser-safe re-export of
the package root's already-pure slice — `./project`, `./group`, and
`./bulk` import nothing but arktype and (type-only) `@corbits/mailbox`, so
this subpath adds no code of its own. It exists because the root export
(`.`) also carries `./routes` (`hono`, `@intx/hub-api`), `./delivery`
(`@corbits/notify/mailbox`), and `./migrations` (`@corbits/mailbox`'s
Postgres migration runner) alongside them, and none of those belong in a
browser bundle — enforced by `bun run check:browser-safe-subpaths`
(`scripts/checks/browser-safe-subpaths.ts`), which walks this subpath's
transitive import graph, not just by convention.

**Owns:**

- `InboxItemSchema`, `InboxItemDetailSchema`, `InboxCountsSchema` — arktype
  wire schemas (and inferred `InboxItem` / `InboxItemDetail` / `InboxCounts`
  types) for the shapes `routes.ts` returns.
- `projectInboxItem`, `projectInboxItemDetail` — project a raw
  `MailboxMessage(Detail)` into the product `InboxItem(Detail)` shape.
- `INBOX_GROUPS`, `isInboxGroup`, `inboxGroupOf`, `classificationFromRefs`,
  `InboxGroup` — the three product groups and how a message's refs map onto
  one.
- `itemsEligibleForMarkAllRead`, `itemsEligibleForClearDone` — the pure
  bulk-op eligibility rules (never touch action rows; only `done` rows
  clear).

**A host injects:** the actual fetch — its own tenant-scoped request
functions that hit `routes.ts`'s endpoints and parse the response with
these schemas (see `apps/web/src/inbox-api.ts`), and any UI-only filter
concept layered on top of `InboxGroup` (e.g. an `"all"` tab).

**Never imports:** no `hono`, `@intx/hub-api`, `@corbits/notify`, or
`@corbits/mailbox`'s runtime (migration/mount) surface — only its
type-only `MailboxMessage` / `MailboxMessageDetail` / `MailboxVocabulary`
shapes, erased at build time.

## Tests

```
cd packages/inbox && bun test
```

`test/delivery.test.ts` needs a reachable Postgres via
`DATABASE_URL=postgres://localhost:5432/workbench_e2e` (parsed the same
way `apps/hub/src/index.ts` does); the rest are pure unit tests.
