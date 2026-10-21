# @workbench/hub

Composition root that mounts the platform API and the Corbits mount block on
one origin. Apps stay generic — every product rule belongs in a package (see
[AGENTS.md](../../AGENTS.md) and [apps/hub/AGENTS.md](AGENTS.md)).

## What it wires

- `src/server.ts` mirrors upstream Interchange's `server.ts`, providing
  `@intx/hub-api` (`createApp`), `@intx/hub-sessions`, auth, and tenant
  middleware, then calls `mountCorbits` (`src/corbits-mount.ts`).
- Boot runs `migrateHub` (`src/migrate.ts`), applying `@intx/db` platform
  migrations and each mounted Corbits library's idempotent migration under a
  Postgres advisory lock.
- `src/corbits-mount.ts` mounts the Corbits mount block:
  - `@corbits/artifacts` (`createArtifactRoutes` and `createWorkflowArtifactRoutes`)
  - Live workflow-run SSE stream routes (`src/run-stream.ts`)
  - `@corbits/agent-token` (`mountAgentTokens` and `createAgentTokenVerifier`)
  - `@corbits/mailbox` (`createMailboxRoutes` with `src/mailbox-persist.ts` and `src/mailbox-send.ts`)
  - `@corbits/cron` (`createCronRoutes` and `createCronTicker`)
  - `@corbits/memory` (`createMemory`, `createMemoryRoutes`, and `mountWorkflowMemory`)
  - `@corbits/oauth-core/hub` (`mountOAuthCallback`, `mountOAuthLogin`, and `createOAuthTokenRefresher` for Codex and xAI)
  - `@corbits/mcp/hub` (`mountMcpDiscovery`)
  - `@corbits/webhooks` (`createHookRoutes`)
- Serves no static files. In dev, `vite dev` (`apps/web`) serves the SPA and
  proxies `/api` to the hub; in e2e, `e2e/lib/browser.ts` serves the built
  `apps/web/dist` in front of the hub on one origin.

## Running

```sh
bun run dev     # from repo root, or `cd apps/hub && bun run dev`
bun run start
```

## Tests

Unit tests sit next to the modules they cover (`src/**/*.test.ts`); DB-backed
hub integration suites live in `e2e/hub/`.

```sh
cd apps/hub && bun test
bun test e2e/hub
```
