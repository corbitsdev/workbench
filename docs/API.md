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

Pushed in practice by `bun run workflows:push -- --kind <kind>`
(`apps/hub/bin/deploy-workflow.ts`), which imports `@workbench/workflow-<kind>`,
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
[{ "deploymentId": "...", "kind": "collateral-generation", "status": "running", "createdAt": "2026-06-19T10:00:00Z" }]
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
