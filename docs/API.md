# GTM Workbench — API Documentation

This document describes the GTM Workbench API surface. For lower-level agent infrastructure and messaging details, see `interchange/docs/API.md`.

## Base URL

- **Development**: `http://localhost:4000`
- **Production**: TBD

## Authentication

Currently unauthenticated for prototype. Lightweight auth (demo gate or minimal) is planned for v1.

## Workflow API

Workflows run on Interchange's native workflow runtime. There is no hub-routed
step state machine — a workflow is a git-backed deployed asset, and a run is an
event log the hub exposes for observation and human-in-the-loop control. See
[`DEPLOYING_WORKFLOWS.md`](DEPLOYING_WORKFLOWS.md) for the full deploy model.

The API splits into one **operator** route (deploy) and three **user** routes
(observe and approve runs).

### Deploy a Workflow (operator)

```
POST /api/internal/workflows/deploy
Authorization: Bearer <HUB_SERVICE_TOKEN>
Content-Type: application/json

<serialized @intx/workflow definition envelope>
```

Operator-only — gated by the hub service token, the same gate as the other
`/api/internal` routes (a member session cannot reach it). The hub validates the
definition, resolves the tenant deploy config (base inference source from the
tenant LLM credential), and hands it to the `@intx/workflow-deploy` orchestrator,
which commits `workflow.json` + `capability-declarations.json` to a git-backed
`workflow` repo and launches one session per step.

Pushed in practice via the admin CLI's **Local actions → Push a workflow** (see
[ADMIN_CLI.md](./ADMIN_CLI.md)), which imports `@workbench/workflow-<kind>`,
serializes its `workflow`, and POSTs it here.

**Response** (200 OK):

```json
{
  "kind": "collateral-generation",
  "deploymentId": "...",
  "result": { "kind": "multi-step", "publicKey": "..." }
}
```

**Status codes:**

- `200`: Deployed
- `400`: Invalid or non-serializable definition (e.g. inline tool factories)
- `401`: Missing or incorrect service token

---

### List Workflow Runs (user)

```
GET /api/v1/workflow-runs
```

Tenant-scoped index of deployed runs from the `workflow_run` table (non-deleted,
`deploymentId IS NOT NULL`).

**Response** (200 OK):

```json
[
  {
    "deploymentId": "...",
    "kind": "collateral-generation",
    "status": "running",
    "createdAt": "2026-06-19T10:00:00Z"
  }
]
```

---

### Stream Workflow Run Events (user, SSE)

```
GET /api/v1/workflow-runs/:deploymentId/stream
Accept: text/event-stream
```

Server-Sent Events stream of the run's native `WorkflowEvent` log, read from the
git-backed `workflow-run` repo via `subscribeKind`. Each message carries
`{ seq, runId, event }`. Event types include `RunStarted`, `StepStarted`,
`StepCompleted`, `StepFailed`, `SignalAwaited`, `SignalReceived`, `RunCompleted`,
`RunFailed`, `RunCancelled` (17 on-disk types in total). The web app reduces the
stream into a `RunState` via `resumeFromLog` and renders the generic run console.

---

### Signal a Workflow Run (user, HITL)

```
POST /api/v1/workflow-runs/:deploymentId/signal
Content-Type: application/json

{ "runId": "...", "signalName": "artifact-approval", "payload": { ... } }
```

Delivers a signal to the running workflow — this is how a human-in-the-loop
approval gate (`awaitSignal`) is resolved. The hub forwards it to the sidecar via
`sendSignalDeliver` at the deployment's mail address.

**Response** (202 Accepted):

```json
{ "accepted": true }
```

> **Not yet wired:** run-start via mail (`POST /api/v1/workflow-runs/:kind/start`)
> is a staging TODO — not yet wired. Runs currently start at deploy time.

---

## Myra Threads API

Multi-thread chat over per-member Myra instances (CL-2309). Each thread is a
`member_agent_instance` row (`templateKey: 'myra'`); the thread `id` is the
mapping id. All routes resolve the caller's global-org membership and 503 if the
member is not provisioned.

```
GET    /v1/me/myra/threads            # list the caller's threads
POST   /v1/me/myra/threads            # { label? } → creates an instance + session
PATCH  /v1/me/myra/threads/:id        # { label } → rename (404 if not found)
DELETE /v1/me/myra/threads/:id        # ends the session, removes the thread (404 if not found)
```

**Thread shape:** `{ id, instanceId, label, createdAt }`. Labels fall back to
`Chat`, `Chat 2`, … by position when unset. List responses are
`{ threads: [...] }`; create responds `201 { thread, created: true }`; rename
responds `{ thread }`; delete responds `{ deleted: true }`.

---

## Personal (`/me/*`) API conventions

Every `/me/*` route resolves the caller's identity server-side from the
session — a request never supplies its own principal id. List routes share a
keyset pagination shape: request `{ limit, cursor }`, response includes
`nextCursor` when more results remain. The list-field name is **not**
uniform across routes — `/me/inbox` returns `{ messages, nextCursor? }` while
`/me/schedules`, `/me/tasks`, and `/me/webhook-triggers` all return
`{ items, nextCursor? }`. Treat this as a known inconsistency, not a
convention to copy — new `/me/*` list routes should use `items`.

### Inbox

```
GET   /me/inbox              # { limit, cursor } → { messages, nextCursor? }
GET   /me/inbox/:id          # message detail
POST  /me/inbox/:id/read     # marks a message read
GET   /me/inbox/events       # SSE — content-free { type: "mailbox", id } delivery
                             # signals; client refetches through the routes above
```

Backed by the workbench-owned `principal_mailbox` table — every principal
(human or agent instance) has one. Delivery is authorized to senders in the
same tenant domain as the recipient.

### Inbox sources — webhooks

See `OWNER_SETUP_INBOX.md` for the full setup sequence and gating order.
Member-facing:

```
GET    /me/inbox-sources          # catalog entries the member can see —
                                  # tenant credential AND owner-enabled;
                                  # owner-disabled or credential-less sources
                                  # are absent, never returned "disabled"
PATCH  /me/preferences            # inboxSource:<key> and, for Linear,
                                  # inboxSource:linear:scope /
                                  # inboxSource:linear:backfill
```

Owner-facing:

```
GET  /owner/inbox-sources         # catalog + per-source enabled state
                                  # (member-role allow grant on
                                  # inbox-source:<key>/enable)
PUT  /owner/inbox-sources/:key    # { enabled } → write/revoke the grant;
                                  # audit-logged; disabling never touches
                                  # member preferences, re-enabling restores
                                  # each member's prior choice
```

Public webhook receivers (each mounted only when its secret env var is set —
absent secret means the route does not exist, not that it 404s):

```
POST /webhooks/linear   # LINEAR_WEBHOOK_SECRET — HMAC-SHA256 over the raw
                        # body (`linear-signature`), 60s replay window;
                        # Issue/Comment create/update events
POST /webhooks/attio    # ATTIO_WEBHOOK_SECRET — HMAC over the raw body
                        # (`Attio-Signature` / legacy `X-Attio-Signature`),
                        # 24h Idempotency-Key dedupe; task.created/updated
POST /webhooks/slack    # SLACK_SIGNING_SECRET — Slack v0 HMAC
                        # (`x-slack-signature` + `x-slack-request-timestamp`),
                        # 5-minute replay window; handles the
                        # `url_verification` handshake, mention events, and
                        # channel_created auto-join
```

Each webhook shares its dedup/idempotency key scheme with the corresponding
poller (Linear: `externalId`; Attio: `sourceRef`) so a poll and a webhook
delivery of the same event collapse into one mailbox row rather than two.

### Schedules and webhook triggers

```
GET/POST/PATCH/DELETE  /me/schedules              # durable scheduled_trigger rows
GET/POST/DELETE        /me/webhook-triggers        # workflow_trigger rows
POST                   /triggers/webhook/:triggerId  # public — secret-authenticated, IP-rate-limited
```

The scheduler, triage, and task-reconciler engines are owner-managed feature
grants (see Owner routes below); the legacy environment kill switches remain
only as emergency overrides — see `IMPLEMENTATION.md`.

The `ScheduledTrigger` shape returned by `/me/schedules` includes
`lastFiredDayUtc` (the UTC day-number the schedule last fired, `null` if
never) alongside `hourUtc` and `enabled` — the client derives "last fired"
and "next fire" display from it rather than the hub computing and returning
those directly. Settings → Schedules (`apps/web/src/components/MySchedules.tsx`,
wired into `apps/web/src/pages/Settings.tsx`) is the member-facing surface for
listing, pausing/resuming, retiming, and deleting these rows.

### Tasks

```
GET/POST/PATCH  /me/tasks            # { limit, cursor } → { items, nextCursor? }
GET             /me/tasks/:id        # single task, owner-scoped, 404 if not caller's
POST            /me/tasks/:id/push   # { adapterId } → send the task to an external
                                     # system (Attio, Linear); ownership-checked
```

Backed by the workbench-owned `task` table, with optional external-system
linkage in `task_external_ref`.

### Owner: features

```
GET  /owner/features         # feature-grant state per feature (+ forcedByEnv)
PUT  /owner/features/:name   # { enabled } → write/revoke the tenant feature grant
```

Owner-guarded; toggles write `admin_audit` records. Features are
deny-by-default; an env-forced feature reports `forcedByEnv: true`.

---

## Recent Calls API

```
GET /recent-calls
```

Fetches recent calls from Granola API (if configured).

**Response** (200 OK):

```json
{
  "calls": [
    {
      "id": "...",
      "title": "...",
      "date": "...",
      "transcript": "..."
    }
  ]
}
```

**Status codes:**

- `200`: Success
- `503`: Granola API not configured

---

## Admin API (governance)

The Admin area (CL-2719/2720/2721/2735/2736) is a thin surface over
Interchange's **native** grant and role system — there is no custom permission
model. Every route is under `/api/v1/admin/*` and gated server-side by an admin
grant guard (`createAdminGrantGuard`): the caller's root-tenant principal is
authorized via `authorize(grantStore, principalId, tenantId, "admin:*", "manage")`,
which only the `owner` (`*:*`) and `admin` (`*`/`manage`) system roles satisfy.
The web nav gate (`/me` now returns `isAdmin`) is cosmetic; the hub is
authoritative. All governance is scoped to the root (global org) tenant.

**Frontend IA (CL-3763):** the web app's standalone `/admin` and `/owner`
routes were unified into role-gated management groups inside `/settings`
(`/settings/admin/*`, `/settings/owner/*`) — the `Settings` side-nav
(`apps/web/src/pages/settings-section-nav.ts`) shows "Workspace users &
agents" only to `isAdmin` viewers and "Workspace management" only to
`isOwner` viewers, reusing the same `AdminLayout`/`OwnerLayout` gates
unchanged. The old `/admin/*` and `/owner/*` paths are wildcard `<Navigate>`
redirects (`apps/web/src/router.tsx`) so every existing deep link still
resolves. This is a navigation move only — the `/api/v1/admin/*` and
`/owner/*` hub routes described above did not change.

Read-only browsers:

```
GET /api/v1/admin/definitions/workflows   # active workflow deployments
GET /api/v1/admin/definitions/agents      # agent definitions
GET /api/v1/admin/definitions/tools       # runnable tool definitions
GET /api/v1/admin/principals              # humans + agent-instance principals + roles
GET /api/v1/admin/principals/:id/grants   # resolved grants via collectGrants (direct + role)
GET /api/v1/admin/roles                   # tenant roles
GET /api/v1/admin/audit                   # compliance audit log (newest first)
```

Admin role management (each mutation validates the target principal and is
audit-logged):

```
POST /api/v1/admin/principals/:id/elevate   # assign the admin role (elevate)
POST /api/v1/admin/principals/:id/demote    # remove the admin role (demote)
```

Role writes go to Interchange's own `principal_role` table using its schema —
the evaluation engine (`authorize` / `collectGrants`), schema, and semantics
stay 100% native. Elevating a principal assigns the `admin` role, which inherits
every lesser capability via its wildcard grants (native role→grant expansion),
so admin is a superset with no per-grant copying; demote removes it.

**Deferred — per-capability grant sharing (CL-2799).** Sharing an individual
capability (e.g. `activity:principal`/`read`) with a principal WITHOUT full
admin was intentionally not shipped: every `/admin/*` route currently gates on
full admin, so such a grant would gate nothing in-product. Real per-capability
enforcement — and the sharing UI + audit retention that go with it — is deferred
to CL-2799. The enforced management surface today is admin role assignment only.

### Audit storage decision (CL-2735)

Cross-principal activity reads (a member viewing another principal's timeline —
open intra-tenant since CL-2743) and every admin role change (elevate/demote)
are recorded in a **dedicated workbench-owned `admin_audit` table**, not
`analytics_event`. The
analytics pipeline is written only from the sidecar (`agent.event`), so hub-side
one-shots like an admin read are invisible there; a compliance surface needs a
hub-owned durable record. Own-principal reads are not logged (noise). The table
touches no Interchange-owned table.

## Health Check

```
GET /health
```

**Response** (200 OK):

```json
{
  "status": "ok",
  "service": "GTM Workbench"
}
```

---

## Error Handling

All endpoints return errors in this format:

```json
{
  "error": "Human-readable error message"
}
```

Common HTTP status codes:

| Code | Meaning                          |
| ---- | -------------------------------- |
| 200  | Success                          |
| 201  | Created                          |
| 400  | Bad request (invalid payload)    |
| 404  | Resource not found               |
| 413  | Payload too large                |
| 500  | Server error                     |
| 501  | Feature not implemented          |
| 503  | Service unavailable (e.g., APIs) |
