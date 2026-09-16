# Portable client bootstrap

The client holds a needs-list manifest and drives a stock Interchange hub
with stock routes only. No server proxies, tables, mounts, grant planting,
or shims — the lane ports to nearly any stock hub.

## Contracts

- No parent bench. Auth creates the user's primary tenant (global
  workspace). Myra runs at top level as a `kind: "workflow"` principal.
- Bench = one user workbench. Workbenches are child tenants of the primary
  tenant — a trust boundary with separate creds, grants, wallet, and
  policy — and each workbench's chat is its **primary thread**: the first
  `conversation.message` sent in the child tenant. Other agent work and
  background comms (delivery threads, onboarding blocks) fork as
  **sub-threads** via `In-Reply-To`/`References` on the sent first message.
- DMs are threads only: never tenants, never created here. A DM is the
  participant-filtered thread set between the user's principal chain and
  exactly one agent chain, derived from stock mail (`To`/`Cc` sets; `M:N`
  via the `List-ID` header where the hub supports it). Creation
  idempotency rides the native `Message-ID` the hub stamps and returns —
  nothing custom. Legacy `dm:<refId>` rows in the client store never
  resolve to tenants and are dropped on load.
- Workbench metadata beyond `Subject`/`List-ID` (icon, prefs) stays in the
  existing client-held store beside created ids — never a server table.

## Files

- `apps/web/src/threads.ts` — thread-native derivation: `deriveThreads`
  (native `Message-ID` grouping with `In-Reply-To`/`References`,
  `List-ID`, and subject fallback), `deriveDmThreads` (DMs as
  participant-filtered threads), and `buildForkReference` (the sub-thread
  ancestry a fork first message carries). No idempotency keys anywhere.
- `apps/web/src/needs-list.ts` — manifest (`buildNeedsList`,
  arktype `NeedsListSchema`/`parseNeedsList`) plus the client-held stores
  (`childTenantStore`, scoped by hub origin and account id, carrying the
  primary-thread `Message-ID` beside created ids; `threadLinkStore`
  carrying sub-thread fork links). Invalid rows are skipped per row,
  never discarding the whole store.
- `apps/web/src/needs-converge.ts` — the `StockHub` port, snapshot read,
  and `convergeNeedsList`. Creation sequence per workbench: stock
  `POST /api/tenants { parentId }` → send the primary-thread first
  message → fork sub-threads as needed via `forkSubThread`. Writes happen
  only after every gap check passes. DMs derive from the caller-supplied
  stock mail snapshot (`deriveDmThreads`); per-agent mailbox search
  (`agent-mailbox-reads`) and full thread reads (`thread-fork-context`)
  stay typed upstream gaps until the hub exposes stock routes for them.
- `apps/web/src/client-bootstrap.ts` — `bootstrapClientSession` wires the
  manifest, port, and store together for signup/open bootstrap and returns
  a typed result (`ready`, `stock-capability-missing` with an upstream-gap
  note, `stock-hub-request-failed`, `client-config-missing`). Myra's
  definition refId resolves from the client workflow catalog
  (`assistant`, productized as Myra); deployment source/offering ids come
  from explicit caller config only — never guessed.
- Wired into first-open (`main.tsx`) and signup (`pages/onboarding-page.tsx`)
  beside server provisioning. Non-gating: a stock gap is logged, not shown.

## Stock endpoints used

- `GET /api/me/principals` — owned memberships (finds the primary tenant),
  every page followed via `nextCursor`
- `GET /api/tenants/:id` — tenant read
- `GET /api/tenants/:id/principals?limit=100` — principals incl. workflows,
  every page followed via `nextCursor`
- `POST /api/tenants` — create workbench child tenants (never for DMs)
- `POST /api/tenants/:id/members/invite` — invite by email (membership is
  the `To`/`Cc` participant set; no membership tables)
- `POST /api/tenants/:id/workflows/deployments` — deploy Myra when absent
  (exact caller-supplied input, posted unchanged)
- `POST /api/tenants/:id/mailbox/messages` — send run-mail: the
  primary-thread first message, then sub-thread forks with native
  `In-Reply-To`/`References` ancestry
- `GET /api/tenants/:id/mailbox/messages` — list run-mail per agent
  mailbox, every page followed via `nextCursor`; the mailbox read splits
  into the primary thread plus forked sub-threads

## Known upstream gaps

Stock Interchange exposes no per-agent mailbox search route
(`agent-mailbox-reads`) and no full thread route
(`thread-fork-context`), so DM derivation reads the mail snapshots the
caller supplies and fork context stays client-held until those stock
routes land. Likewise Myra deployment without caller-supplied inputs
(`deploy-workflow-inputs`), projecting a workflow identity into a child
room by `refId` (`project-workflow-principal`), and non-member role
assignment (`principal-roles`) stop before writes rather than guessing.
