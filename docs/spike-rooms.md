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
SPIKE_BENCH_TENANT=<tenant id> bun scripts/repro/spike-room-bench.ts
```

The harness boots its own hub and sidecar on a spare port, opens a room,
runs a fixed number of turns, and prints: room-open time and the number
of `workflow_run` rows opening a room adds, send-acknowledgement and
first-token percentiles, how many reads happen after mount, and the
status of reading each reply's child run id back through the existing run
surfaces (`/workflows/runs/:runId`, `.../events`, `.../turns`).
