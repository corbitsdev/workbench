# Portable client bootstrap

The client holds a needs-list manifest and drives a stock Interchange hub
with stock routes only. No server proxies, tables, mounts, grant planting,
or shims — the lane ports to nearly any stock hub.

## Contracts

- No parent bench. Auth creates the user's primary tenant (global
  workspace). Myra runs at top level as a `kind: "workflow"` principal.
- Bench = one user workbench. Workbenches are child tenants of the primary
  tenant.
- Every owned workflow agent surfaces as a DM: a 1:1 `kind: "chat"` child
  tenant with the same identity projected via `refId`; groups use the same
  shape with more principals.

## Files

- `apps/web/src/needs-list.ts` — manifest (`buildNeedsList`,
  arktype `NeedsListSchema`/`parseNeedsList`) plus the client-side child
  tenant store (`childTenantStore`), scoped by hub origin and account id.
  Invalid rows are skipped per row, never discarding the whole store.
- `apps/web/src/needs-converge.ts` — the `StockHub` port, snapshot read,
  DM derivation (`deriveDesiredDirectMessages`: one chat child per active
  top-level workflow `refId`, idempotent by `dm:<refId>`), and
  `convergeNeedsList`. Writes happen only after every gap check passes.
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
- `POST /api/tenants` — create workbench child tenants
- `POST /api/tenants/:id/members/invite` — invite by email
- `POST /api/tenants/:id/workflows/deployments` — deploy Myra when absent
  (exact caller-supplied input, posted unchanged)

## Known upstream gaps

Stock Interchange cannot yet carry a workflow identity into a child
room by `refId` (`project-workflow-principal`), so DM creation stops
before any write with that typed gap. Likewise Myra deployment without
caller-supplied inputs (`deploy-workflow-inputs`) and non-member role
assignment (`principal-roles`) stop before writes rather than guessing.
