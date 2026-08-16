# @corbits/task-planner

Myra auto-dispatch: a person types an outcome, the bench's default agent
("Myra") turns it into a validated plan — use an existing agent, create a
new one with specific tools/skills, or a short chain of steps — and the
plan dispatches exactly like a manually-launched task.

## Composition with @intx/*

No direct `vendor/intx/**` imports; every platform capability arrives
through `@corbits/folded-runs` and `@intx/*` published packages
(`@intx/db`, `@intx/hub-api`, `@intx/hub-sessions`, `@intx/log`,
`@intx/types`, `@intx/workflow-deploy`), the same seam `@corbits/tasks` and
`@corbits/chat` use. It depends on `@corbits/tasks` for the actual launch
(`launchTask`, chain machinery), `@corbits/agent-directory` for the
sanctioned agent-deploy path when the plan creates a new agent, and
`@corbits/skills`/`@corbits/workflow-catalog` as inventory sources.

## Key modules

- `src/inventory.ts` — `assembleInventory`: builds the compact
  `PlannerInventory` (agents, tool packages, skills, models) offered to
  Myra, from host-injected `InventorySources` listers.
- `src/task-spec.ts` — `parseTaskSpec`/`validateTaskSpecAgainstInventory`:
  fail-closed arktype parsing of Myra's reply plus a check that every
  reference it makes was actually in the offered inventory.
- `src/planner-run.ts` — `runPlanner`: resolves Myra, assembles the
  inventory, runs the one-shot planning prompt, parses and validates the
  reply.
- `src/spawn.ts` — `spawnFromTaskSpec`: dispatches a validated spec —
  `{use}` calls `@corbits/tasks`' `launchTask` directly; `{create}`
  re-validates bounds, checks a create grant, and deploys a new definition
  before launching; a `{chain}` spec deploys every step's definitions
  all-or-nothing before launching leg 1.
- `src/planner-created-naming.ts` — the `myra-task-<slug>-<hex>` handle
  convention and the picker-exclusion predicate for planner-created agents.
- `src/routes.ts` — `createPlannerRoutes`: `POST /`, personal to the
  requesting principal, mapping fail-closed planning errors to a plain 422.

## Running tests

```
cd packages/task-planner && bun test
```

No drizzle suite in this package; no `DATABASE_URL` needed.
