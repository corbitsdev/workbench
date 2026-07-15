# CL-3688 — Hub: `stopped` status + owner-scoped stop API

## Why users could not “cancel” before

- **No Stop in the product UI** — active runs had no cancel control.
- **Archive** (`POST /workflow-exec/records/:runId/archive`) was the only user-facing halt: it marks active runs **`failed`**, tears down the per-run deployment, and **soft-deletes** the record (vanishes from Insights list). That is removal, not “stopped in history.”
- **Operator abort** (`POST /workflow-exec/runs/:runId/abort`) is admin-only and also maps to **`failed`**.

## CL-3688 deliverable (this branch)

### Data model

- Add **`stopped`** to `workflowRunStateStatus` (`apps/hub/src/db/schema.ts`).
- **`TERMINAL_RUN_STATUSES`** includes `stopped` (`run-status.ts`).
- **`markRunUserStopped`** sets `status: stopped` + `endedAt` (distinct from `markRunStopped` → `failed` for archive/abort).

### API

- **`POST /workflow-exec/records/:runId/stop`**
  - Same auth/ownership gate as archive (`assertRunOwnership`, optional `?tenantId=`).
  - Active runs: mark **`stopped`**, reclaim per-run deployment (shared `tearDownActiveRun` helper with archive).
  - Terminal runs: idempotent `{ stopped: true }`, no teardown.
  - **Does not** soft-delete — record remains in `GET /workflow-exec/records` with `status: stopped`.

### Stats / facts

- Run-kind stats include **`stopped`** bucket (`getRunKindStats`).
- Facts projection includes `stopped` in terminal backfill; user stop forces **`outcome: cancelled`** when index is `stopped`.

### Tests

- `workflow-run-records.test.ts`: stop happy paths, awaiting, terminal idempotent, 403, 404.
- `run-status.test.ts`: terminal partition includes `stopped`.

## Follow-ups (CL-3687 / CL-3689)

- Web: Stop control on dock/pane; map `stopped` in `workflow-run-status.ts`; history label **Stopped** (not Archive).
- Docs: `docs/PRODUCT.md`, `docs/ADMIN_CLI.md` — Stop vs Archive vs abort.

## Verification

```bash
cd apps/hub && bun test --isolate src/routes/workflow-run-records.test.ts src/workflow-executor/run-status.test.ts
```
