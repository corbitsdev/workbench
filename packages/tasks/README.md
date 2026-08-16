# @corbits/tasks

Spawn-and-return agent tasks: a person picks an agent definition, writes a
prompt, and a one-shot folded run launches on its own — no channel, no
participants, no settings. When the run finishes, its reply lands in the
Inbox as a `task-result` item, and a task can optionally chain hand-offs to
further agents, each leg carried out in turn.

## Composition with @intx/*

No direct `vendor/intx/**` imports — every platform capability (launch,
session orchestration, ID generation, credential resolution) arrives
through `@corbits/folded-runs` and `@intx/*` published packages, the same
seam `@corbits/chat` uses: `@intx/db` for the platform drizzle handle,
`@intx/hub-api`/`@intx/hub-sessions` for routes and session deps,
`@intx/hub-common` for id generation, `@intx/types` for run addressing, and
`@intx/workflow-deploy` for definition lookups. It deliberately does not
depend on `@corbits/chat`; the one thing genuinely shared with chat
(recognizing finalized-turn artifacts) lives in `@corbits/turn-artifacts`.

## Key modules

- `src/launcher.ts` — `launchTask`, the launch primitive: writes the task
  row in the same transaction as the run and sends the opening prompt.
- `src/orchestrator.ts` — `createTaskOrchestrator`: subscribes to the
  sidecar's `agent.event` stream and settles a task to `done`/`failed` on
  its run's terminal event, writing the Inbox item.
- `src/chain.ts` — `advanceChain`: hands a multi-agent task's work from one
  leg to the next as each settles.
- `src/stuck-legs.ts` — `createStuckLegSweep`: fails a hand-off nobody
  claimed within its lease and writes an honest Inbox item.
- `src/store.ts` — `TaskStore` (`createDrizzleTaskStore` /
  `createMemoryTaskStore`), covering the `task` and `task_leg` tables.
- `src/routes.ts` — `createTaskRoutes`: `POST/GET /tasks`, personal to the
  requesting principal (another principal's task 404s, never 403s).
- `src/migrations.ts` — this package's own migration ledger.

## Running tests

```
cd packages/tasks && bun test
```

`test/store.drizzle.test.ts` and
`test/task-not-in-channel-list.drizzle.test.ts` need a live Postgres:
`DATABASE_URL=postgres://localhost:5432/workbench_e2e`.
