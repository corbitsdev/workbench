# @workbench/sidecar

Generic execution host that dials in to a hub over WebSocket and hosts
whatever it is deployed. Apps stay generic (see
[AGENTS.md](../../AGENTS.md)): the sidecar knows no deployment by name
and holds no policy about what runs on it — the hub tells it everything
over the wire, so hosted and local topologies are identical and any
number of sidecars can dial the same hub unchanged.

Boot order matters: orphaned tarball-cache staging is swept before any
apply work is accepted, the process identity keypair loads before
anything touches the data dir's substrate, the deploy router is captured
during orchestrator construction, restored deployments re-establish
before the hub connection opens (mailbox registrations must be live
before the hub routes to them), the watchdog arms for the first connect
attempt, and only then does the link dial out.

## What it wires

- `@intx/hub-agent`'s `createSidecarOrchestrator` and `HubLink` for the
  WebSocket connection to the hub; workflow deployments arrive as
  `agent.deploy` frames and run in supervised workflow-process children
  via `@intx/workflow-host`.
- `src/workflow-host-wiring/` binds `createWorkflowSupervisor` to this
  host's specifics: the mail-bus instance, the sidecar's Ed25519 signing
  keypair, the substrate `RepoStore` handle, and `Bun.spawn` as the
  subprocess spawner. Logic that would benefit an alternative sidecar
  implementation lives in `@intx/workflow-host`, not here.
- `@intx/hub-sessions`' `createAgentRepoStore`, `@intx/inference`'s
  provider adapter registry, and `@intx/tool-packaging`'s tarball cache.
- `signing-keypair.ts`, `hub-link-watchdog.ts`, `shutdown.ts` — process
  identity, reconnect supervision, and graceful drain on exit.

## Key modules

- `index.ts` — composition root; owns the boot order described above.
- `config.ts` — env schema for hub location and process identity.
- `workflow-host-wiring/` — `supervisor.ts`, `transport.ts`,
  `step-strategy.ts`, `asset-materialization.ts`, `wire-validation.ts`.
- `workflow-substrate-factory/` — per-run substrate construction:
  `child-runtime.ts`, `step-env.ts`, `storage-paths.ts`.
- `run-grants.ts`, `step-agent-tools.ts` — grant resolution and tool
  materialization for a running step.
- `bin/workflow-child` — the subprocess entry point workflow steps spawn
  into.

## Running

```
bun run dev   # apps/sidecar/package.json
bun run start
```

## Tests

```
cd apps/sidecar && bun test
```
