# apps/hub

Hono + TypeScript backend. Thin product layer on top of Interchange.

## Responsibilities

- Agent provisioning: create instances, launch sessions, assign credentials and tools
- Credential storage: encrypt at write, decrypt before pushing to sidecar
- Workflow orchestration: call ingestion, extraction, artifact generation
- Tenant and workspace management

## Key rules

- Read `interchange/docs/` before touching any agent, session, credential, or grant path — Interchange owns those contracts
- All env var validation lives in `src/config.ts` — use `requireEnv()`, never fallback
- Structured logging via `@intx/log` — no `console.log`
- Inject stateful deps (db, sessionService) into routers; import stateless singletons directly
- `eventCollectors.create()` must be called immediately after `sessionService.launchSession()` — missing this loses all conversation history

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
