# apps/hub

Hono + TypeScript backend. Thin product layer on top of Interchange.

## Responsibilities

- Agent provisioning: create instances, launch sessions, assign credentials and tools
- Credential storage: encrypt at write, decrypt before pushing to sidecar
- Workflow deployment: deploy native `@intx/workflow` definitions via the operator-gated deploy route, and expose read/signal routes over the native workflow-run event stream; the hub runs no custom workflow orchestration
- Tenant and workspace management

## Key rules

- Read `interchange/docs/` before touching any agent, session, credential, or grant path — Interchange owns those contracts
- All env var validation lives in `src/config.ts` — use `requireEnv()`, never fallback
- Structured logging via `@intx/log` — no `console.log`
- Inject stateful deps (db, sessionService) into routers; import stateless singletons directly
- `eventCollectors.create()` must be called immediately after `sessionService.launchSession()` — missing this loses all conversation history
- **Every new HTTP route must be OpenAPI-discoverable.** Wrap each route with `describeRoute({ tags, summary, parameters, responses })` from `hono-openapi` (mirror the `/workflows/deploy` route). The admin CLI builds its entire menu from `/openapi.json` (grouped by `tags`), so a route without `describeRoute` is invisible to operators — it can only be hit by raw HTTP. Use a `tags` value matching the resource group it belongs to.

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
