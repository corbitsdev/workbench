# Spike: rooms as data, turns as child runs

A throwaway experiment (CL-6323, Phase 0) that answers one question:
what does a chat room feel like when the room is rows and each message
is its own addressable agent turn?

It runs beside today's chat path, never in place of it. Everything lives
in `packages/chat/src/spike/` plus one env-flagged block in
`apps/hub/src/index.ts`, so removing the experiment is
`git rm packages/chat/src/spike` and deleting that block.

## What is different

| | today's chat | the spike |
| --- | --- | --- |
| opening a room | child tenant, workflow asset, two runs, two deploys | one row |
| a message | a signed mail in the platform mailbox | one row plus one publish |
| a turn | implicit — shares the host run's identity | a child run of the room's `onTrigger` section, with its own run id and event log |
| a reply | carries no run id | carries the child run id of the turn that produced it |
| the client after a send | refetches messages, threads and pins | reads the room once at mount and lives on the stream |

The room's living run is deployed lazily on its first message and stays
warm from then on: its single `onTrigger` section services every later
message as another occurrence, so a turn costs no deploy.

## Running it

Start a hub with the flag set, against a tenant that already has an
inference source seeded:

```
WORKBENCH_SPIKE_ROOMS=1 bun run dev
```

Routes are mounted at `/api/tenants/:tenantId/spike-rooms`: `POST /` to
open a room, `GET /:roomId/messages` to hydrate once, `POST
/:roomId/messages` to send, `GET /:roomId/stream` for everything after
that.

## Measuring it

```
bun scripts/repro/spike-room-bench.ts
```

The harness is self-contained. It builds its own database
(`<DATABASE_URL database>_spike_bench`, rebuilt per run), boots its own
hub and sidecar on a spare port, signs up an account, connects the local
Ollama through the real onboarding path, promotes that Ollama's one chat
model to the head of the tenant catalog, and then opens a room and runs
turns against it. Nothing in a developer's own database is read or
written, and no key material is read from anywhere but the environment
the hub itself already runs under. `OLLAMA_BASE_URL` overrides the
default `http://localhost:11434`; `SPIKE_BENCH_TURNS` sets the turn
count.

It prints room-open time and the `workflow_run` rows opening a room
adds, send-acknowledgement and first-token percentiles split cold/warm,
how many reads happen after mount, what a mid-turn kill of the execution
plane does to the room, and what the run surfaces
(`/workflows/runs/:runId`, `.../events`, `.../turns`) return for a
reply's run id.

## Measured (2026-08-20, one run, local Ollama `llama3.2:latest`)

| # | acceptance | measured | verdict |
| --- | --- | --- | --- |
| 1 | opening a room deploys nothing | 15ms, 0 `workflow_run` rows | pass |
| 2 | a sent message is visible fast | send ack p50 7ms, p95 9ms (n=5) | pass |
| 3 | no reads after mount | 1 hydration GET, 0 GETs afterwards | pass |
| 4 | first agent token on a warm room | 501 / 551 / 576 / 612ms — p50 576ms (cold, first-message deploy: 14.1s) | pass, warm |
| 5 | a turn killed mid-flight | room rows survive (`GET messages` 200); the room's run comes back terminal and answers nothing ever again | fail |
| 6 | the reply's run id is traceable | the reply carries `turn__<n>`; the room run's `/events` and `/turns` return 200 and name it in `ChildSpawned` / `ChildCompleted`; `GET /workflows/runs/turn__<n>` is 404 | partial |

What (5) actually does: the harness kills the sidecar — the whole
execution plane — as a turn streams. The hub never wobbles and the room
stays readable. Whether the turn in flight dies or squeaks through is a
race (both were observed); when it does die it produces no failure event
of its own, it simply hangs until the five-minute turn timeout. What is
not a race is what follows: the sidecar comes back, restores the
deployment, and the run is terminal, so every later message is rejected
with `workflow run ... is terminal` and no reply, and the room is dead
for good. A turn is not separately killable today — it is an occurrence
inside the room's run, not its own process — so the smallest fault that
can be injected takes the whole room with it.

What (6) actually does: a turn's child run id is a step-scoped id
(`turn__0`), not a `workflow_run` row, so the run routes 404 on it. The
correlation that does work is through the room's run: its event log
carries `ChildSpawned`/`ChildCompleted` naming the child run id and the
child definition, so a reply can be walked back to the events of the
turn that produced it — one hop, not a direct address.

Two things the run surfaced that are not the spike's own doing: the hub
logs `Ignoring terminal event for run 'turn__<n>': it does not belong to
source deployment`, and the insights collector cannot persist a turn
whose run id it has never seen (`turn_part` foreign-key failures on
every turn). Both say the same thing — child run ids exist inside the
workflow runtime but nothing above it knows them yet.
