# Work unit vs product task

**Status:** contract for Workbench Durable Work Queue (WQ.1–WQ.6)  
**Linear:** CL-4073 (WQ.1), CL-4072…CL-4074, CL-4075, CL-4071, CL-4076

## Two objects

| | **Product task** | **Work unit** |
|---|---|---|
| Audience | Humans (and agents as collaborators) | Hub workers only |
| Lifecycle | open → in_progress → done/cancelled (product UX) | pending → leased → done \| dead |
| Ownership | Tenant + owner principal; assignees | Worker id (`lease_owner`) for the lease window only |
| Concurrency | Multiplayer edits; no exclusive lock for “who is working” | Exactly-one worker via claim + lease |
| Retry | Human or product policy | Automatic backoff → dead letter |
| Side effects | Artifacts, mail, status, UI | Ingest, capture, agent turns — durable background work |
| Lease | **Never** | `lease_until` + `lease_owner`; reclaim when expired |

**Non-goals**

- Not a general message broker / pub-sub
- Not a replacement for Interchange sessions or workflow runs
- Not leasing the product `task` row as the job claim
- Not Redis / PGMQ until scale forces it — Postgres table + `FOR UPDATE SKIP LOCKED` is enough

Pattern inspiration: classic PG job queue with visibility timeout
([AmineDiro writeup](https://aminediro.com/posts/pg_job_queue/)).

## Work unit fields

| Field | Role |
|---|---|
| `id` | UUID PK |
| `tenant_id` | Tenant scope |
| `kind` | `granola_call` \| `knowledge_capture` \| `agent_task_turn` (extensible) |
| `idempotency_key` | Unique with `(tenant_id, kind)` — enqueue is safe to retry |
| `status` | `pending` \| `leased` \| `done` \| `dead` |
| `payload` | JSONB typed per kind |
| `attempts` | Completed attempt count |
| `max_attempts` | Default 8 |
| `next_attempt_at` | Due time for pending / backoff |
| `lease_owner` | Worker id holding the lease (null when not leased) |
| `lease_until` | Visibility timeout; reclaim when `now() >= lease_until` |
| `last_error` | Last fail message |
| `created_at` / `updated_at` | Audit |

## Claim / heartbeat / ack / fail

1. **Enqueue** — insert pending; `ON CONFLICT DO NOTHING` on `(tenant_id, kind, idempotency_key)`. Does not revive `done`/`dead` rows (operator retry does).
2. **Claim** — single statement: select due rows (`pending` and `next_attempt_at <= now()`, or `leased` with `lease_until <= now()`), `FOR UPDATE SKIP LOCKED`, set `status=leased`, `lease_owner`, `lease_until = now() + lease_ms`, bump `attempts` only on fail path (not on claim). Order by `next_attempt_at`.
3. **Heartbeat** — extend `lease_until` while still leased by the same owner (long LLM / agent turns). Returns false if the lease was lost; worker must abort.
4. **Ack (complete)** — owner-fenced: `status=done` only when `lease_owner = workerId` and status is leased; clear lease fields.
5. **Fail** — owner-fenced under the same predicate. If `attempts + 1 >= max_attempts` → `dead` + `last_error`; else `pending`, set backoff `next_attempt_at`, clear lease, store error. A reclaimed lease cannot be failed by the old owner (no double-count).
6. **Operator retry** — dead → pending with `attempts=0`, clear error, `next_attempt_at=now()`.
7. **Operator discard** — dead stays dead (idempotent ack-dead); optional hard-delete later.

Expired leases reclaim on the next claim — **no separate sweeper process**.

Workers use a **unique** `workerId` per process (pid + random suffix) so multi-replica hubs do not share a lease identity.

## First three kinds

| Kind | Idempotency key | Payload (sketch) | Producer | Consumer |
|---|---|---|---|---|
| `granola_call` | `note:{noteId}` (or use dedicated `granola_call_job` table with **equivalent** lease semantics) | note id | Workspace list tick | Granola pipeline runner |
| `knowledge_capture` | `artifact:{artifactId}:v{version}` or external ref | source ids + content hash | After product write commits | Capture adapt/plan/write |
| `agent_task_turn` | `task:{taskId}:turn:{turnKey}` | task id, reason, policy version | Auto-pickup policy | Session launch / resume |

## Product task rules (agent auto-pickup)

- Policy selects **eligible** open tasks (feature gate, assignee/agent grant, not already having a live `agent_task_turn` unit).
- Enqueue work unit referencing `task_id` — **never** `FOR UPDATE` the task as the job lease.
- Worker claims the **work unit**, launches/resumes Interchange session; approvals still gate external side effects.
- Task status / mail / artifacts are **outcomes** of the turn, not the lease mechanism.
- UI may show “agent running” from work-unit lease state without conflating it with task status.

## Knowledge capture

- Product write commits first.
- Then enqueue `knowledge_capture` (idempotent). Capture failure retries on the unit; **must not** roll back the product write.
- Feature flag / cutover: inline capture may remain until outbox is proven (`KNOWLEDGE_CAPTURE_OUTBOX`).

## Granola

Existing `granola_call_job` already has enqueue-dedupe, backoff, and dead. WQ.3 hardens claim to **SKIP LOCKED + lease_until + heartbeat** so process death cannot stick a row in `processing` forever. Semantics match work units even if the table stays specialized.

## Owner ops (WQ.6)

- List dead (and aged-leased) units with kind, tenant, error, attempts, timestamps.
- Actions: **retry** (re-queue), **discard** (ack-dead).
- Health: depth by kind/status, oldest pending age, dead count.
- Owner/admin only.

## Touchpoints today

- Granola: list-on-tick enqueue + off-tick process (`granola-call-job-queue` / runner) with the same claim/lease/heartbeat/owner-fence pattern.
- Knowledge capture: outbox enqueues a `knowledge_capture` work unit after the product write (capture failure never rolls back the write).
- Agent auto-pickup: policy selects open assigned tasks → enqueues `agent_task_turn` work units → worker claims lease and launches/resumes a session. **Product task rows are never leased.**
- Owner ops: `/owner/work-units` list dead / aged-leased, retry, discard, health.

## Review notes (ship-with-deferrals)

**Fixed (critical):**

- Owner-fenced `complete` / `fail` on both `work_unit` and `granola_call_job` (require `lease_owner = workerId`).
- Unique per-process `workerId` (`pid` + random suffix) so multi-replica hubs do not share a lease identity.
- Heartbeat returns `boolean`; workers abort in-flight work when the lease is lost.
- Tests cover stolen complete/fail no-ops, multi-claim isolation, lease expiry reclaim.

**Deferred (non-blocking):**

1. **Granola `fail` still takes caller-supplied `attempts`** rather than reading under the owner fence (work_unit already does). Risk is low because complete/fail are owner-fenced; double-count on race is still possible if a stolen worker races before reclaim. Follow-up: mirror work_unit’s SELECT-then-UPDATE under fence.
2. **No dedicated sweeper / metrics exporter** — reclaim is claim-time only; owner health is count-based. Fine until multi-tenant ops need latency histograms.
3. **Work unit kinds are free-form strings** — no registry/enum yet; add when a second product surface wants to plug in.
4. **Schedule fire → work unit (WQ.7 / CL-4070)** not in this PR; schedules fire through the existing scheduler path.
5. **Visibility timeout vs hard kill of LLM calls** — abort signal is wired; underlying model SDKs may not always honor it mid-stream. Acceptable; track if we see zombie token spend after reclaim.
