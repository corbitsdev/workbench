# @workbench/sim

Scale and behavior simulator for Workbench: scripted teams of humans,
agents, and routines played against a real booted stack (hub + sidecar +
Postgres), judged by hard assertions, with a markdown report per run.

## Run

```sh
DATABASE_URL=postgres://localhost:5432/workbench bun run sim
# or a named scenario:
bun run sim busy-team-week
```

The run boots a scratch stack against the sibling `<database>_e2e`
database (same isolation as `scripts/e2e`), provisions the scenario's
cast, plays every step, and writes `output/<scenario>.md`. Exit code is
nonzero on any red assertion.

## Modes

- `noop` (default): every inference source is pinned at the hub's own
  noop-inference endpoint — agent turns complete instantly with zero
  network. This is the volume mode.
- `--mode ollama`: quality sampling against a local model
  (`OLLAMA_BASE_URL`). Not implemented yet; refuses honestly.

## Pieces

- `src/scenario.ts` — the DSL: `humanSay` (with `ref`/`inReplyToRef`
  threading and agent `mentions`), `routineFire`, `waitQuiet`, and
  virtual-time `label`s; plus pure `summarizeScenario`/`validateScenario`.
- `src/metrics.ts` — pure assertion helpers: thread integrity, drop
  count, send→persist latency percentiles, DB row growth.
- `src/target.ts` — boots the stack and provisions humans (real
  sign-ups, invites, grants), agents (echo deployments invited into the
  channel), and routines (heartbeat definition, fired via run-now).
- `src/runner.ts` — plays steps and collects facts.
- `src/scenarios/` — `busy-team-week` (green today) and honest TODO
  stubs for 1k/10k volume, multi-workbench crossover, and ollama
  quality sampling (`todo.ts` lists what each needs first).
