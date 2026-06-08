# GTM Workbench — Implementation Documentation

## Technology Stack

| Layer              | Technology     | Version                      |
| ------------------ | -------------- | ---------------------------- |
| Package manager    | Bun            | 1.2+                         |
| Frontend           | React          | 19                           |
| Frontend build     | Vite           | 8                            |
| Styling            | Tailwind CSS   | 4                            |
| Animation          | Framer Motion  | 12                           |
| State management   | TanStack Query | 5                            |
| Backend            | Hono           | 4                            |
| ORM                | Drizzle ORM    | 0.45                         |
| Database           | PostgreSQL     | 18.2-alpine                  |
| Object storage     | MinIO          | latest                       |
| Agent runtime      | `@intx/agent`  | workspace (via interchange/) |
| Runtime validation | arktype        | 2.x                          |

## TypeScript Configuration

- Extends `tsconfig.base.json` from interchange
- `strict: true`
- `noUncheckedIndexedAccess: true` — check array/object access before using
- `exactOptionalPropertyTypes: true` — optional props cannot be `undefined`
- `verbatimModuleSyntax: true` — use `import type` for type-only imports
- No `any`, no `as` type assertions. Use `unknown` and narrow.

## File Organization

- **Applications**: `apps/web/`, `apps/hub/`
- **Shared libraries**: `packages/*`
- **Examples**: `examples/*` (reference consumers, not throwaway)
- No standalone TypeScript files in repository root

## Shared Packages

### `apps/sidecar/` — Tool Runner

The sidecar carries three tool runners merged via `mergeToolRunners` before `filterToolRunner` gates model-visible definitions to whatever the hub configured in `HarnessConfig.tools`:

| Runner               | Source                                | What it covers                                            |
| -------------------- | ------------------------------------- | --------------------------------------------------------- |
| `posixTools`         | `@intx/tools-posix`                   | File system, shell, LSP                                   |
| `askPrincipalRunner` | `@workbench/approvals`                | Human approval flow (calls hub `/api/internal/approvals`) |
| `hubToolRunner`      | `apps/sidecar/src/hub-tool-runner.ts` | All hub-managed tools (exa, granola, etc.)                |

`HubToolRunner` is generic — it forwards every tool call to `POST /api/internal/tools/run` using `sidecarToken` auth. It has no knowledge of specific tools. Adding a new tool package never requires a sidecar change.

### `packages/agents` (`@workbench/agents`)

Agent definitions, system prompts, custom directors, and the `InstanceEvent` → `ChatMessage` adapter.

```
src/
  personal-agent/
    prompt.ts        — Myra system prompt
    definition.ts    — Myra agent definition
    director.ts      — Custom director filtering inbound senders
  granola/
    prompt.ts        — Oat system prompt
    definition.ts    — Oat agent definition
    director.ts      — Custom director filtering inbound senders
  adapter.ts         — InstanceEvent → ChatMessage adapter
  prompt-builder.ts  — Shared prompt formatting utilities
  index.ts           — Public exports
```

#### `prompt-builder.ts` exports

- `PromptFormat` — `'xml' | 'markdown'`
- `formatFromModel(model: string): PromptFormat` — returns `'xml'` for `claude-*` models, `'markdown'` for all others
- `buildSystemPrompt(sections: PromptSection[], format: PromptFormat): string`
- `buildContextBlock(context: Record<string, string>, format: PromptFormat): string`

### `packages/hub-crypto` (`@workbench/hub-crypto`)

AES-256-GCM credential encryption primitives for Interchange-based hubs. No workbench-specific dependencies — reusable by any hub that stores credentials in Interchange's `credential` table.

Exports:

- `parseEncryptionKeys(raw: string): CredentialKeyRegistry` — parses `CREDENTIAL_ENCRYPTION_KEYS` format; validates key lengths; selects highest version as active
- `encryptSecret(keys, tenantId, plaintext): string` — returns `enc:vN:<base64>` ciphertext; throws if input already has `enc:` prefix
- `decryptSecret(keys, tenantId, ciphertext): string` — parses version from prefix, selects key, decrypts; throws on unknown version or auth tag mismatch

### `packages/tools-*` — Tool Packages

Each tool package is self-contained and follows the same shape:

```
packages/tools-<name>/
  src/
    index.ts    — tool definitions, AgentTool handlers, *_HUB_TOOLS registry entry
  package.json
  tsconfig.json
```

Every tool package exports:

- `create<Name>Tools(config): AgentTool[]` — returns AgentTool handlers for use in an agent runtime
- `*_HUB_TOOLS: Record<string, ToolEntry>` — hub registry entries; spread into `KNOWN_TOOLS` in `apps/hub/src/lib/tool-registry.ts` to register

No tool package reads env vars or resolves credentials. Config (`apiKey`, `baseURL`) is always supplied by the caller.

**`packages/tools-exa`** (`@workbench/tools-exa`): Exa search API. Exports `EXA_HUB_TOOLS` with `exa_search` (providerName: `'exa'`).

**`packages/tools-granola`** (`@workbench/tools-granola`): Granola notes API. Exports `GRANOLA_HUB_TOOLS` with `granola_list_notes`, `granola_get_note`, and `granola_list_folders` (providerName: `'granola'`). `granola_list_notes` paginates with `page_size` (default 10, max 30) and accepts `created_after`/`created_before`/`updated_after`/`folder_id` filters; `granola_list_folders` surfaces folder IDs for that `folder_id` filter.

#### `packages/tool-template` (scaffold)

A minimal `@workbench/tools-*` package skeleton for quickly duplicating. Contains:

- `src/index.ts` with stub definition, stub `createTools`, and stub `*_HUB_TOOLS`
- `package.json` with correct deps (`@intx/agent` devDep, `@intx/types` devDep)
- `tsconfig.json` extending the workspace base

Copy the directory, rename, replace stubs. No other files needed to ship a new tool.

#### `packages/tool-agent` (scaffold)

A minimal agent package skeleton for agents that primarily expose tool-based capabilities. Contains:

- `src/definition.ts` — `credentialRequirements` (openai-compatible only), `capabilities.tools: []`
- `src/prompt.ts` — stub system prompt using `buildSystemPrompt`
- `src/director.ts` — stub director wrapping `createDefaultDirector`
- `src/index.ts` — public exports
- `package.json` and `tsconfig.json`

Copy, rename, fill in the tool list and prompt. Wire provisioning in `tenant-provisioning.ts`.

### `packages/chat` (`@workbench/chat`)

Transport-agnostic chat UI components. No dependency on a specific agent transport or WebSocket implementation.

## Naming Conventions

- **Files**: Lowercase, hyphens for multi-word (`pain-point.ts`, `session-service.ts`)
- **Factory functions**: `create*` prefix (`createSessionService`, `createPipeline`)
- **Predicates**: `is*` prefix (`isValidPainPoint`)
- **Retrieval**: `get*` prefix (`getSessionById`)
- **Handlers**: `handle*` prefix (`handleAnalyze`)
- **Variables**: `camelCase` for regular, `SCREAMING_SNAKE_CASE` for constants
- **ID generation**: Use `generateId` imported from `@intx/hub-common` — do not reimplement

## API Surface

### Agent Provisioning

| Method   | Route                                          | Input                                                                               | Output                                                                     |
| -------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET`    | `/agents`                                      | `?tenantId=...`                                                                     | `{ data: AgentInstance[] }`                                                |
| `POST`   | `/agents`                                      | `{ name, systemPrompt, tenantId, credentialIds: string[] }`                         | `{ instanceId, agentId, agentName, tenantId, launched, launchError? }` 201 |
| `POST`   | `/tenants/:tenantId/credentials`               | `{ provider, name, apiKey, model, baseURL? }`                                       | `{ credentialId, providerId }` 201                                         |
| `DELETE` | `/tenants/:tenantId/credentials/:credentialId` | — (Interchange-native; manage grant created at write time)                          | `{ ok: true }` 200                                                         |
| `POST`   | `/instances/:instanceId/sessions`              | `{}` (no credential IDs — Interchange resolves from agent's credentialRequirements) | `{ launched, launchError? }` 200                                           |

Agent launch does not accept credential IDs. The agent definition declares `credentialRequirements`; Interchange resolves them at launch time by walking the tenant ancestor chain. Grants written at credential-creation time are for management access only (delete/update via Settings UI), not for resolution.

All routes that trigger a session launch return `launched: boolean` and an optional `launchError` string. Launch failures are surfaced to callers; they do not cause the route to return an error status (the agent/credential record was still created). Session launch is retried up to 3 times with a 1 s delay before reporting failure.

**Tool-grant persistence**: at launch, `persistInstanceToolGrants` (`apps/hub/src/routes/agents.ts`) reconciles the instance principal's `tool:*` grant rows to `capabilities.tools` — deleting the principal's existing `origin: system` tool grants and re-inserting the current set via `buildToolGrantRows` (`apps/hub/src/lib/tool-grants.ts`). These rows are persisted (not synthesized in memory) so they survive sidecar reconnect; migration `0013_backfill_tool_grants.sql` backfills them for instances provisioned before this change. See ARCHITECTURE.md § Tool authorization.

### Workspace Creation

| Method | Route         | Input              | Output                                     |
| ------ | ------------- | ------------------ | ------------------------------------------ |
| `POST` | `/workspaces` | `{ name: string }` | `{ tenantId, tenantSlug, tenantName }` 201 |

Creates an Interchange tenant + seeds owner role/principal/grants for the caller. Idempotent by slug.

### Collateral Generation

| Method | Route                    | Input                                                           | Output                      |
| ------ | ------------------------ | --------------------------------------------------------------- | --------------------------- |
| `POST` | `/collateral-generation` | `{ inputArtifactIds: string[], outputTypes: CollateralType[] }` | `{ workflowId, artifacts }` |

Each `outputType` generates independently in parallel via `@intx/agent`. Results are stored as `artifact` rows with `kind = outputType` and `workflowId` FK.

### Workflow Routes

| Method | Route                  | Input                                            | Output                                                         |
| ------ | ---------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `POST` | `/workflows`           | `{ transcript, source }`                         | `{ id, status, steps }`                                        |
| `GET`  | `/workflows/:id`       | —                                                | `{ id, status, currentStep, steps }`                           |
| `POST` | `/workflows/:id/steps` | `{ step, painPointIds, feedback, collateralId }` | `{ id, status, currentStep, steps }`                           |
| `GET`  | `/workflows/catalog`   | —                                                | `[{ kind, name, description, steps, credentialRequirements }]` |
| `GET`  | `/workflows/tools`     | —                                                | `[{ name, providerName, description }]`                        |
| `GET`  | `/workflows/enabled`   | `?tenantId`                                      | `[{ kind, ..., assignments }]`                                 |
| `POST` | `/workflows/enabled`   | `{ kind, tenantId?, assignments }`               | `{ kind, ..., assignments }`                                   |
| `GET`  | `/recent-calls`        | `?tenantId&kind`                                 | `{ calls }`                                                    |

#### Per-step credential & tool assignments

A `WorkflowType` (`@workbench/workflow-core`) declares `steps[]`, where each step lists its own
`credentialRequirements` (by `providerName`) and allowed `tools`. The collateral workflow's intake
step requires a `granola` credential plus the Granola tools; analyze/generate/improve require an
`openai-compatible` inference credential.

When a workflow is added to a workbench, the install UI collects one credential per requirement
(select existing or add new inline) and a tool selection per step. `POST /workflows/enabled`
validates these against the step definitions and stores them on the install record
(`workbench_workflows.assignments`, shape `Record<stepName, { credentialIds, toolIds }>`). At run
time, each step resolves its assigned credential via `resolveCredentialById` (falling back to the
name-based resolver for installs predating assignments); Granola recent-calls/intake resolve the
intake step's assigned credential. The web `CredentialField` component (select-or-add-new) backs
both this flow and the agent `NewAgentModal`.

#### Per-step execution mode (agent vs inline)

Each generative step (`analyze`/`generate`/`improve`) runs in one of two modes, decided per run from
`workflow_runs.input.stepConfig` (shape `Record<stepName, { agentId?, toolIds? }>`, persisted via
`PATCH /workflows/:id/step-config`):

- **Agent mode** — `stepConfig[step].agentId` is set (an agent _instance_ id). The step resolves its
  inference source from the assigned agent's own credential requirements:
  `resolveAgentStepInferenceSource` looks up the `agentInstance` to find its agent definition, calls
  `resolveInstanceSources` (the same Interchange resolver used at agent launch), and decrypts the
  secret. The agent already declares its inference provider, so an agent-mode step needs only tenant
  access to the agent — **not** a per-step workflow LLM credential. A missing/unresolvable agent
  source returns `400` pointing at the agent's credentials.
- **Inline mode** — no agent assigned. The step uses its configured workflow LLM credential via
  `resolveStepInferenceSource` (the name-based assignment flow above).

Both modes produce an `InferenceSource` consumed identically by the step runners, so the only
difference is where the source originates. The run-step handler in `apps/hub/src/routes/workflow.ts`
branches on `agentId` to pick the resolver.

### Health

| Method | Route     | Output                              |
| ------ | --------- | ----------------------------------- |
| `GET`  | `/health` | `{ status: "ok", service: string }` |

## Database Schema

### Artifacts

The `artifact` table is the single store for all workflow and agent outputs.

- `id` (UUID, primary key)
- `kind` (CollateralType enum: case-study, one-pager, email-draft, call-document, ...)
- `sessionId` (UUID, foreign key, **nullable** — workflow-level artifacts have no session)
- `workflowId` (UUID, foreign key, nullable — links to collateral_generation_workflow)
- `content` (text)
- `createdAt` (timestamp)

### Collateral Generation Workflow

- `id` (UUID, primary key)
- `userId` (text)
- `inputArtifactIds` (UUID array)
- `outputTypes` (CollateralType array)
- `status` (enum)
- `createdAt` (timestamp)
- `updatedAt` (timestamp)

### Enabled Workflows (`workbench_workflows`)

Tracks which workflow kinds a tenant has added, with per-step assignments.

- `id` (text, primary key)
- `tenantId` (text)
- `kind` (text) — workflow kind
- `assignments` (jsonb, nullable) — `Record<stepName, { credentialIds: string[]; toolIds: string[] }>`
- `enabledAt` (timestamp)
- Unique `(tenant_id, kind)` for idempotent upserts.

### Workbench User (provisional cache)

- `id` (UUID, primary key)
- `userId` (text)
- `personalTenantId` (text) — cached personal Interchange tenant ID
- `workbenchPrincipalId` (text) — cached principal ID in the shared workbench tenant

> **Pending removal (CL-1245)**: This table is a provisional cache. It will be removed when session/route scoping moves to `tenantId`/`principalId` directly.

### Migration Sequence

| Migration                             | Description                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `0004_collateral_generation_workflow` | Adds `collateral_generation_workflow` table; makes `artifact.sessionId` nullable; adds `artifact.workflowId` FK |
| `0005_workbench_user`                 | Adds provisional `workbench_user` cache table                                                                   |
| `0012_workbench_workflow_assignments` | Adds `workbench_workflows.assignments` (jsonb) for per-step credential/tool assignments                         |

## Agent Architecture

### Credentials and Grants

#### Credential sources by agent

- **Personal agent (Myra)**: `source: 'tenant'`, `name: 'Myra LLM'` for openai-compatible inference — resolved against the user's personal tenant. The credential is stored tenant-owned (`principalId: null`) and created during onboarding.
- **Granola agent (Oat)**: `source: 'tenant'` for both `granola` and `openai-compatible` — resolved against the workspace tenant

#### Creating credentials (Settings flow)

> **Custom workbench logic** — Interchange stores credentials in its `credential` table but does not encrypt secrets. The workbench adds an encryption layer via `@workbench/hub-crypto` and owns the create/delete endpoints rather than delegating to Interchange's generic credential endpoint.

Credentials are created via `POST /api/v1/tenants/:tenantId/credentials` (workbench-owned route in `apps/hub/src/routes/agents.ts`). The hub:

1. Checks for a name conflict in the tenant — returns 409 if a credential with the same `name` already exists.
2. Calls `ensureProvider` (**Interchange**: inserts into Interchange's `provider` table in `intxSchema`, or reuses existing by `(tenantId, name)`) to create or reuse a provider record for the given plugin.
3. Inserts into Interchange's `credential` table with `principalId: null` (tenant-owned) and the secret encrypted via `encryptSecret` from `@workbench/hub-crypto`.
4. Returns `{ credentialId, providerId }`.

**Credentials are always tenant-owned** (`principalId: null`). This is required for Interchange's `source: 'tenant'` resolution to find them at agent launch time.

Required fields: `provider`, `name`, and `apiKey`. `provider` accepts arbitrary service keys such as `'granola'`; inference providers are restricted to `anthropic`, `openai`, `google-genai`, and `openai-compatible` wherever the UI is selecting an inference source. `model` is required only for inference providers. `baseURL` is optional for service credentials and required for `openai-compatible` inference credentials.

Secrets are stored with an `enc:vN:` prefix — see `@workbench/hub-crypto`. Plain secrets are never written to the DB.

#### Credential decryption invariant — three paths, all must decrypt

> **Danger zone.** Credentials are stored encrypted (`enc:v1:<ciphertext>`). The sidecar must **always** receive plaintext API keys. Any code path that calls `sidecarRouter.sendSourcesUpdate` is responsible for decrypting first. There are exactly three such paths; all three must be audited whenever the credential or session-launch code changes.

| Path          | Where                                                           | How decryption happens                                                                                                                                                  |
| ------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Launch**    | `launchAgentSession` in `apps/hub/src/routes/agents.ts`         | Sources resolved via `resolveInstanceSources`, then each `apiKey` passed through `decryptSecret` before `sessionService.launchSession` is called                        |
| **Rotation**  | `pushDecryptedSourceUpdates` in `apps/hub/src/routes/agents.ts` | Called from `POST /tenants/:tenantId/credentials` and `POST /instances/:instanceId/sessions`; resolves and decrypts sources for all **running** instances in the tenant |
| **Reconnect** | `agent.reconnected` listener in `apps/hub/src/index.ts`         | Registered **after** `createHubSessionOrchestrator`. Calls `pushDecryptedSourcesForInstance` (single-instance variant, no status filter) and **awaits** it              |

#### Why the reconnect path needs two listeners

Interchange's orchestrator also listens on `agent.reconnected` and calls `sendSourcesUpdate` with the raw (encrypted) DB values — it has no knowledge of the workbench encryption layer. `emitAndAwait` runs listeners sequentially in registration order and **awaits each one** before moving to the next. Because our listener is registered after the orchestrator's, it fires second and overwrites the encrypted sources with decrypted ones.

This is intentional and unavoidable: we cannot modify `interchange/`. Two `sendSourcesUpdate` wire calls per reconnect is the cost of keeping the boundary clean.

#### Why `pushDecryptedSourcesForInstance`, not `pushDecryptedSourceUpdates`, for reconnect

`pushDecryptedSourceUpdates` queries `agentInstance WHERE status = 'running'`. The orchestrator sets `status = 'running'` **inside its own listener**, after `sendSourcesUpdate`. When our listener fires, the reconnecting instance is still `'deployed'` and would be silently skipped. `pushDecryptedSourcesForInstance` takes the specific instance directly and applies no status filter.

#### What must not change

- **Do not `void` the call inside the reconnect listener.** `emitAndAwait` awaits the promise the listener returns. `void` detaches the async body, destroying the sequencing guarantee and causing the push to race with (and likely lose to) Interchange's encrypted push.
- **Do not reorder listener registration.** Our listener must be registered after `createHubSessionOrchestrator`.
- **If you add a new caller of `sidecarRouter.sendSourcesUpdate`**, verify it sends decrypted keys.

The reconnect bug was introduced as CL-1396 and fixed in the same ticket.

#### Credential verification (ancestor-chain lookup)

> **Interchange-provided**: `getAncestorChain` is exported from `@intx/db` (`interchange/packages/db/src/credential-resolution.ts`). The workbench calls it; it is not reimplemented.

When verifying credentials at provisioning or session-launch time, the hub calls `getAncestorChain(db, tenantId)` to walk the Interchange tenant hierarchy up to the root, then checks `credential.tenantId IN (chain)`. This allows a credential in a parent tenant to be granted to an agent in a child tenant, matching Interchange's authz model.

#### Provisioning an agent with credentials

The workbench does **not** pass credential IDs at agent launch time. Interchange resolves credentials from the tenant automatically using the agent's `credentialRequirements`.

When provisioning an agent, the hub:

1. Creates the agent definition with `credentialRequirements` declaring what the agent needs (e.g. `[{ providerName: 'openai-compatible', source: 'tenant', name: 'Myra LLM' }]`).
2. Creates the agent instance (**Interchange**: uses Interchange's `agent`, `agentInstance`, `tenant`, `principal` tables from `@intx/db`).
3. Launches the session via `sessionService.launchSession` — Interchange's `resolveCredentialRequirement` walks the tenant hierarchy and builds `InferenceSource[]` from the agent's requirements. No credential IDs are passed to this call.

**No credential IDs in launch calls.** Credentials live on the tenant. The agent declares what it needs. Interchange finds them.

The `grant` table is still used for one purpose: giving the creating principal manage access to the credential record so the Settings UI can delete/update it (`resource: credential:{id}`, `origin: creator`, `principalId: callerPrincipal.id`). This is a management grant, not a resolution grant.

#### Credential picker (frontend)

> **Custom workbench UI** over Interchange data. The `listTenantCredentials` call hits Interchange's `/api/tenants/:tenantId/credentials` (mounted by `createApp` from `@intx/hub-api`) — the workbench does not re-implement the list/read endpoints.

The `useCredentials` hook (`apps/web/src/hooks/use-credentials.ts`) fetches the caller's accessible principals via `getMyPrincipals()` (**Interchange**: `/api/me/principals`), then fetches credentials per tenant via `listTenantCredentials(tenantId)` (**Interchange**: `/api/tenants/:tenantId/credentials`). Returns `{ principals, credentialsByTenant, isLoading }`.

The `CredentialPicker` component (`apps/web/src/components/CredentialPicker.tsx`) renders a checkbox list displaying each credential as `"{cred.name} — {tenantName}"`. It receives the full `credentialsByTenant` map — not filtered to a single workspace — so credentials from parent tenants are visible and selectable (matching the ancestor-chain grant model).

The `CredentialSettingsPage` (**custom**) at `/settings/credentials` shows all credentials across all tenants the user is a principal in, with tenant labels. Create calls `POST /api/v1/tenants/:tenantId/credentials` (workbench). Delete calls `DELETE /api/v1/tenants/:tenantId/credentials/:credentialId` (workbench — verifies principal membership before calling Drizzle delete on Interchange's `credential` table).

#### Route mounts

**Interchange-owned routes** (mounted automatically by `createApp` from `@intx/hub-api`, available at `/api/tenants/:tenantId/*`):

- `GET /api/tenants/:tenantId/credentials` — list credentials (used by frontend)
- `GET /api/tenants/:tenantId/principals` — list principals
- `GET /api/tenants/:tenantId/grants` — list grants
- All other tenant/principal/grant CRUD

**Workbench-owned routes** (in `apps/hub/src/routes/`, mounted under `/api/v1/`):

- `POST /v1/tenants/:tenantId/credentials` — create with encryption + manage grant
- `DELETE /api/tenants/:tenantId/credentials/:credentialId` — Interchange-native (manage grant created at write time enables this)
- `POST /v1/agents` — provision agent + launch session
- `POST /v1/instances/:instanceId/sessions` — launch session for existing instance (no credential IDs; Interchange resolves from agent's credentialRequirements)
- `POST /v1/workspaces`, `GET /v1/agents`, etc.

**Internal routes** (sidecarToken auth, mounted under `/api/internal/`):

- `POST /api/internal/approvals` — human approval callback from sidecar (ask_principal tool)
- `POST /api/internal/tools/run` — hub-proxied tool execution. Body: `{ tenantId, toolName, args }`. Hub resolves the tenant credential for the tool's provider from Interchange, calls the tool package handler, returns `{ result: string, isError: boolean }`. Credentials are decrypted before use; never stored in sidecar.

### Deploy Prompts

Agent deploy prompts are currently **static** (no dynamic context injected at deploy time). Dynamic context (current date, operator name, etc.) will be injected at session start via the hub-client layer. See CL-1297 — not yet implemented.

### Session Liveness and Relaunch

An instance is reachable for mail only when its row `status` is `running` — Interchange's session orchestrator sets this when the agent's session connects, and the mail route (`POST /tenants/:tenantId/agents/instances/:instanceId/mail`) returns `409` (`Instance is not running`) for any other status.

A hub or sidecar restart drops the in-memory agent — the sidecar re-registers "with 0 agents" — but leaves the DB rows behind: `agentInstance.status` stays `deployed` and the old `agentSession` row stays `active`. The session record is therefore **not** a reliable liveness signal across restarts.

`relaunchInstanceIfNeeded` (`apps/hub/src/routes/agents.ts`, called from `GET /v1/me`) gates on the live instance status, not the stale session record: it returns early only when `instance.status === 'running'`, and otherwise relaunches (subject to the tenant having an active credential). This is what brings Myra back automatically after a deploy or crash — without it, every `/mail` POST kept 409ing on a restarted instance.

The Myra chat (`apps/web/src/components/PersonalAgentChat.tsx`) also self-heals at send time: if `sendMail` throws an `ApiError` with status `409`, it calls `launchInstanceSession(instanceId)` and retries the send once. This covers the window between a restart and the next `/v1/me` relaunch, so a send during that gap heals rather than throwing and dropping the message. A genuine failure surfaces the recoverable error notice instead of crashing the panel.

## Environment Configuration

All environment validation lives in `apps/hub/src/config.ts`. Variables are validated at startup via `requireEnv()` — no silent defaults for required values.

`loadConfig()` sets a module-level singleton; `getConfig()` returns it. Library modules that need config values import `getConfig()` directly — they do not reach into `process.env` themselves. This keeps validation in one place and makes config access testable via `mock.module('../config', ...)`.

### Added Variables

| Variable                     | Required | Purpose                                                                                                                                                                                                                         |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKBENCH_TENANT_SLUG`      | Yes      | Slug of the shared GTM Workbench Interchange tenant                                                                                                                                                                             |
| `CREDENTIAL_ENCRYPTION_KEYS` | Yes      | Versioned AES-256-GCM key registry for credential encryption. Format: `1:<base64_32_bytes>[,2:<base64_32_bytes>...]`. Highest version encrypts new values; all versions decrypt. Generate a new key: `openssl rand -base64 32`. |

## Authentication

### Google OAuth Configuration

Google OAuth is required for all users. Configuration:

- **Client ID / Secret**: Configured via `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env.workbench`
- **Redirect URI**: `http://localhost:5174/auth/callback` (local) or production equivalent
- **Domain Allowlist** (optional): `GOOGLE_ALLOWED_DOMAINS` — comma-separated domains (e.g., `example.com,partner.com`). If set, only users with email addresses in these domains can authenticate. If unset, any Google account is allowed.
- **Session Handling**: Sessions are stored in secure, HTTP-only cookies with CSRF protection.
- **Trusted Origins**: The API whitelists CORS origins via `TRUSTED_ORIGINS` (comma-separated).

## Local Development

### Infrastructure

```bash
docker compose up -d
```

Services:

- PostgreSQL on `localhost:5433`
- MinIO on `localhost:9000` (API) and `localhost:9001` (console)

### Environment

```bash
cp env.workbench.example .env.workbench
# Edit optional values
```

### Running

```bash
# All services in parallel
bun run dev

# Or individually
bun run --filter @workbench/hub dev
bun run --filter @workbench/web dev
```

## Build Pipeline

```bash
bun run format    # Prettier
bun run lint      # ESLint + docs freshness
bun run check     # tsc -b --noEmit
bun run test      # bun test
```

Or via `make all` if Makefile is available.

## Railway Deployment

The workbench deploys as three separate Railway services from the same repo. This is a **shared monorepo**: every service builds with the repo root as its Docker build context (Root Directory `/`), because they all depend on the shared lockfile, `packages/*`, and the vendored `interchange/packages/*` workspaces.

### Services

| Service | Config file                 | Dockerfile                | Purpose                                 |
| ------- | --------------------------- | ------------------------- | --------------------------------------- |
| Hub     | `apps/hub/railway.toml`     | `apps/hub/Dockerfile`     | Hono API, DB migrations                 |
| Web     | `apps/web/railway.toml`     | `apps/web/Dockerfile`     | Static SPA (Vite build served by Caddy) |
| Sidecar | `apps/sidecar/railway.toml` | `apps/sidecar/Dockerfile` | Interchange sidecar, agent lifecycle    |

Per Railway's monorepo model, the config file does **not** follow the Root Directory — set each service's Config-as-Code path to the absolute repo-root path (e.g. `/apps/hub/railway.toml`). `dockerfilePath` inside each config is relative to the build context (repo root). Each config declares `watchPatterns` so a service redeploys only when its own code or shared dependencies change.

### Dockerfiles

The hub and sidecar Dockerfiles follow the same pattern:

1. **Builder stage** (`oven/bun:1.3-alpine`): fetches and verifies `interchange/` from GitHub at a pinned commit + SHA256, installs workspace dependencies, builds the app
2. **Runtime stage** (`oven/bun:1.3-slim`): copies only what is needed to run

The pinned `INTERCHANGE_COMMIT` and `INTERCHANGE_SHA256` args must be updated together across all three Dockerfiles whenever interchange is upgraded.

`apps/sidecar/Dockerfile` builds nothing and runs directly from TypeScript source via `bun run`. `apps/web/Dockerfile` runs `vite build` in the builder stage and serves the static output via Caddy with an SPA fallback to `index.html`; it runs no Node/Bun process at runtime.

### Volumes

Both services require a **persistent volume** mounted in the Railway dashboard.

| Service              | Mount path | Env var                  | Contents                          |
| -------------------- | ---------- | ------------------------ | --------------------------------- |
| Sidecar              | `/data`    | `SIDECAR_DATA_DIR=/data` | Per-agent git repos, key pairs    |
| Hub (if self-hosted) | `/data`    | `HUB_DATA_DIR=/data`     | Agent repo mirrors, signing state |

### Sidecar Environment Variables

| Variable           | Description                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `HUB_WS_URL`       | WebSocket URL of the Interchange hub (e.g. `wss://hub.example.com/api/sidecars/ws`)                |
| `SIDECAR_ID`       | Stable opaque identifier for this sidecar instance (e.g. `gtm-staging`). Any slug format is valid. |
| `SIDECAR_TOKEN`    | Auth token for hub registration                                                                    |
| `SIDECAR_DATA_DIR` | Path on the persistent volume (e.g. `/data`)                                                       |

## Agent Runtime and LLM Inference

All LLM inference uses `@intx/agent` from `interchange/packages/agent`. The agent runtime provides:

- **Unified inference interface** across OpenAI, Anthropic, Google GenAI, and OpenAI-compatible endpoints
- **Configuration management** via `InferenceSource` (model, API key, base URL, provider)
- **Error handling and logging** with classified error types and structured output
- **Conversation history persistence** via pluggable context stores (isogit by default, in-memory for ephemeral tasks)
- **Tool execution framework** for agent-driven workflows

### Using `@intx/agent` for LLM Inference

**Single-call inference** (extraction, analysis, one-shot generation):

1. Create an `InferenceSource` from environment variables:

   ```typescript
   import type { InferenceSource } from '@intx/types/runtime';

   const source: InferenceSource = {
     id: `my-task-${id}`,
     provider: 'openai',
     baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL || 'https://api.openai.com/v1',
     apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
     model: process.env.OPENAI_COMPATIBLE_MODEL || 'gpt-4o-mini',
   };
   ```

2. Create a temporary agent with an ephemeral context directory:

   ```typescript
   import { createAgent } from '@intx/agent';
   import { tmpdir } from 'node:os';
   import { join } from 'node:path';
   import { randomUUID } from 'node:crypto';

   const contextDir = join(tmpdir(), `task-${randomUUID()}`);
   const agent = await createAgent({
     contextDir,
     sources: [source],
     defaultSource: source.id,
     systemPrompt: 'Your system instructions...',
     tools: [],
     closeTimeoutMs: 1000,
   });
   ```

3. Send your prompt and extract the response:

   ```typescript
   const result = await agent.send(userMessage);
   await agent.close();

   const data = JSON.parse(result.reply);
   ```

### Granola API v1 Integration

When configured with `GRANOLA_API_KEY`, Oat ingests recent sales calls from Granola's public API:

- **Endpoints**: Granola API v1 `GET /v1/notes` (list), `GET /v1/notes/{id}?include=transcript` (single note), and `GET /v1/folders` (list folders). The base URL is owned by the tool package (`GRANOLA_DEFAULT_BASE_URL`)
- **Pagination**: `page_size` query parameter (default 10, max 30) plus a `cursor`. Note titles may be `null`
- **Filters**: list-notes accepts `created_after`, `created_before`, `updated_after`, and `folder_id`. The scheduler client (`apps/hub/src/lib/granola.ts`) uses `created_after` to fetch only notes newer than the last poll rather than over-fetching and filtering in memory
- **Authentication**: Bearer token via `GRANOLA_API_KEY`
- **Integration**: Call recordings are fetched and stored as call document artifacts (kind: `call-document`) in the `artifact` table
- **Scope**: Entirely optional; Oat runs continuously and surfaces calls automatically

## UI Components

### Sidebar Navigation (`StepSidebar`)

Located in `apps/web/src/components/StepSidebar.tsx`.

**Behavior:**

- Displays workflow steps with numeric indicators (or checkmarks for completed steps)
- Current step highlighted with white background and shadow
- Completed steps show green checkmark instead of number
- Pending steps dimmed (opacity 50%)

**Collapse/Expand:**

- Toggle button in header (chevron icon that rotates)
- Collapsed width: 64px; expanded width: 224px
- Spring transition: `stiffness: 300, damping: 30`
- Labels and source info fade out via `AnimatePresence` when collapsed

**Dynamic Step Derivation:**

- Steps are not hardcoded per page. Each page calls `buildSteps(workflow.currentStep, STEP_LABELS)` from `apps/web/src/lib/steps.ts`
- `buildSteps()` returns array of steps with status (`completed` | `current` | `pending`) based on current workflow step index

### Page Transitions

**Cross-page animation** (when moving between workflow stages):

- Uses `AnimatePresence mode="wait"` to ensure outgoing page exits before incoming page enters
- Each page wrapped in `motion.div` with:
  - Entry: `opacity: 0, y: 20` → `opacity: 1, y: 0`
  - Exit: `opacity: 0, y: -20`
  - Duration: 0.3s

**Panel animations** (within a page):

- Left panels animate in from left: `x: -40, opacity: 0` → `x: 0, opacity: 1`
- Right panels animate in from right: `x: 40, opacity: 0` → `x: 0, opacity: 1`
- Spring transition: `type: 'spring', stiffness: 300, damping: 30`
- Staggered delays: left panel 0.1s, right panel 0.15s
