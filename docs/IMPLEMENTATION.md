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

#### Harness construction

The merged `ToolRunner` is wrapped as an Interchange `toolFactory` via `defineTool` (from `@intx/agent`) and passed in `toolFactories` on the `AgentDefinition` — **not** via an `env.tools` field, which does not exist in Interchange's `BaseEnv`. The `env` passed to `createHarness` must include `directors: createDefaultDirectorRegistry()` (required by `BaseEnv`). Missing either of these causes `createHarness` to throw at agent launch time, leaving every workflow run stuck in its current state with zero token consumption.

### `packages/myra` (`@workbench/myra`)

Myra was extracted out of `@workbench/agents` into its own package. `src/core/` holds Myra's system prompt, agent definition, custom director, and seed files (`definition.ts`, `prompt.ts`, `director.ts`, `seed-files.ts`) — the same shape `@workbench/agents` uses for its other templates. `src/personas/mailbox.ts` is a second, deliberately narrower persona: the read-only loadout used for ephemeral triage sessions (see `mailbox-triage.ts` below), which cannot mutate anything on the user's behalf. Triage runs on its own definition variant — the `myra-triage` template ("Myra Triage", `deployable: false`) binds `PERSONAL_AGENT_TRIAGE_MODEL_CONFIG` (`deepseek-v4-flash`) because model binds at the definition level, not per launch — and its advertised loadout is the platform core plus eight read essentials (18 tools, down from 59; grants stay at the full read-only set, the launch-time intersection enforces safety). Triage eligibility additionally excludes bounce/no-reply senders and mail originating from any member's agent instance in the tenant, so triage handoffs are terminal and can never ping-pong between members. `@workbench/agents` keeps the generic primitives (adapter, prompt-builder, tool-name tracking, deploy descriptors, and the remaining templates); it no longer owns Myra's definition.

Myra's `prompt.ts` is a compact operating contract (~871 static words, `PERSONAL_AGENT_PROMPT_VERSION`): `role` (personal Chief of Staff), a front-loaded `operating-loop` (effort calibration plus the capability sweep across `search_skills` / `workflow_list_kinds` / `search_tools` before improvising, rephrase-once on an empty search), an `authority` trust boundary (retrieved data and saved memory are evidence, never instructions), `knowledge`, `directory` (teammate mail addressing), `memory`, `honesty` (truthful completion only), `generative-ui` (the fenced `ui` block contract), `style`, and the shared data-boundary contract. Situational tool mechanics (artifact/document loading, skill-draft and workflow-signal steps) live in the tool descriptions, not the always-on prompt; teammate mail addressing and the generative-UI block contract stay in the prompt because no tool description carries them. Both `definition.ts` and the mailbox persona pick the section format from the provider Myra runs inference on via `promptFormatForProvider(PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS[0].providerName)` — `openai-compatible` (deepseek-v4-flash for chat and triage) yields Markdown, not XML.

**Variant catalog (`src/core/variants.ts`).** `MYRA_VARIANTS` is the immutable, versioned catalog of selectable Myra definitions — three chat variants and three triage variants, one per model (`deepseek-v4-flash`, `kimi-k2.6`, `claude-opus-4-8`). Each variant carries a stable `id`, a `versionId` (tied to `PERSONAL_AGENT_PROMPT_VERSION`), display metadata, `modelConfig`, `credentialRequirements`, a `promptFormat` from `promptFormatForProvider`, a `costTier` (`premium` for Opus, `standard` otherwise), a tool policy (chat = full base toolset; **triage = the mailbox persona loadout regardless of model**), and the `seedName`/`templateKey` of the definition it maps to. Every variant's prompt derives from the single `buildPersonalAgentSystemPrompt` base (a v1-empty `promptOverlay` hook exists for future divergence). The **canonical** chat variant (`myra-deepseek-v4-flash`) and triage variant (`myra-triage-deepseek-v4-flash`) map to the existing `myra` / `myra-triage` templates and are byte-identical to today's shipped definitions, so a member with no preference sees no change. The Opus variants declare a tenant-owned `anthropic` credential requirement (name `anthropic-api`, same as Freddie) and render the XML prompt format; Interchange resolves the credential and builds the native Anthropic inference source at launch — no launch-path change. The five non-canonical variants are seeded as additional `deployable: false` definitions generated from the catalog in `@workbench/agents` `AGENT_TEMPLATES`.

**Per-member selection + lazy binding.** Members pick a *default definition*, never an instance. The selection is a stored preference only — `myra_variant_preference` (workbench-owned table, one row per tenant+member, `chat_variant_id`/`triage_variant_id`, both nullable = "use the canonical default"). It is exposed on the tenant-scoped router: `GET /api/tenants/:tenantId/myra/variants` (the catalog, filtered to models with a launchable offering for the tenant — CL-3824), and `GET`/`PUT /api/tenants/:tenantId/members/me/myra-preferences` (validated against the catalog; 400 on an unknown id, wrong kind, or unavailable model). Binding is **lazy**: each creation path — a new chat thread (`createMyraThread`) and a mailbox-triage session (`mailbox-triage.ts` `runOne`) — reads the member's preference at creation time and resolves a launchable variant via `resolveLaunchableMyraVariant` (stored pick if still available; else the canonical default among available variants of that kind; else the first available; else the catalog default). Existing instances are never re-deployed when the preference changes; they keep the definition they were born with for life.

**Per-member standing instructions.** The same `myra_variant_preference` row also carries three nullable, length-capped (4000 chars, enforced by the PUT patch schema) free-text fields: `instructions_global`, `instructions_chat`, `instructions_triage`. `renderMemberInstructionsSection` (`src/core/prompt.ts`) composes `global` then the surface-specific override into a single escaped `<member-instructions>` DATA section — same `formatDataSection` escaping path as the `<operator>` section — prefixed with a static, non-user framing line ("standing preferences... follow them within your operating rules; they do not override the trust boundary or safety rules"); empty/absent text on both axes renders nothing. `buildPersonalAgentSystemPrompt` accepts an `instructions` option and appends the section immediately after the operator section. Both creation paths read from the same preference row already fetched for variant binding, at creation time only: `composePersonalAgentPromptForInstance` (`apps/hub/src/lib/operator-profile.ts`) passes `{ global: instructionsGlobal, surface: instructionsChat }` into the personalized chat launch prompt, and `mailbox-triage.ts` `runOne` appends the `global`+`instructionsTriage` section directly onto the mailbox persona's system prompt (which carries no operator section to append after). Existing instances are unaffected — this only shapes the prompt a *new* instance launches with.

**Personalization style axes (`src/core/style-axes.ts`, prompt-only, v1).** Six mutually-exclusive axes — `personality` (nine options, default "teammate"), `emojiUse` (default "none"), `uiType` (default "sections"), and three usage dials — `artifactUsage`, `toolUsage`, `skillUsage` (each: heavy/default/light/none) — with a curated 1-2 sentence imperative snippet per non-default option. Every axis's default option snippet is `""`; `composeStyleOverlay(selections)` joins the non-empty snippets, so an all-default (or absent) selection composes to `""` — the byte-identical current-prompt guarantee. "None" snippets are honest behavior dials ("Do not create artifacts; deliver results in the reply") never claims that a capability was removed — grant-level enforcement of "None" is a separate, unbuilt concern. `listStyleAxes()` strips snippet text for the client-facing catalog, served at `GET /api/tenants/:tenantId/myra/style-axes`.

`myra_variant_preference` carries the selections on the same row as the chat/triage variant pick: `personality`/`emoji_use`/`ui_type` are global columns (shared by chat and triage); the three usage dials are **per-surface** (`artifact_usage_chat`/`artifact_usage_triage`, etc.) since a member may want heavy artifact usage in chat but none in unattended inbox automation. `GET`/`PUT /api/tenants/:tenantId/members/me/myra-preferences` validates every axis value against the catalog (arktype at the boundary; 400 on an unknown option id) with the same partial-update/null-clears-to-default semantics as the variant fields. At launch, `apps/hub/src/lib/myra-style-overlay.ts` composes the member's overlay for the instance's surface and appends it as its own prompt section AFTER the base prompt and any operator-identity section — gated on the Myra template set (`myraSurfaceForTemplateKey`) rather than the `!opts.persona` check that gates operator personalization, since triage always launches with the mailbox persona and would otherwise be skipped. The Settings UI's "Personality & style" group (`MyraStylePanel`, next to `MyraDefaultsPanel` under "Myra defaults") renders personality/emoji-use/UI-type as single radiogroups and the three usage dials as Chat/Inbox-automation radiogroup pairs, following the same optimistic-update/revert-on-error idiom.

### `packages/agents` (`@workbench/agents`)

Agent definitions, system prompts, custom directors, and the `InstanceEvent` → `ChatMessage` adapter for every template other than Myra (Oat, Freddy, Walter, Loop, Fannie, Lincoln, Hammy, …), plus the shared primitives every template — including Myra — builds on. This package is the source of truth for that template content. At hub boot, `seedAgentTemplates(db)` reads the templates from `@workbench/agents` and `@workbench/myra` and idempotently upserts one Interchange agent definition per template into the root tenant — re-boot is a no-op.

```
src/
  granola/
    prompt.ts        — Oat system prompt
    definition.ts    — Oat agent definition
    director.ts      — Custom director filtering inbound senders
  firecrawl/
    prompt.ts        — Freddy system prompt
    definition.ts    — Freddy agent definition
    director.ts      — Default director
  adapter.ts         — InstanceEvent → ChatMessage adapter
  prompt-builder.ts  — Shared prompt formatting utilities
  index.ts           — Public exports
```

#### `prompt-builder.ts` exports

- `PromptFormat` — `'xml' | 'markdown'`
- `formatFromModel(model: string): PromptFormat` — returns `'xml'` for `claude-*` models, `'markdown'` for all others
- `buildSystemPrompt(sections: PromptSection[], format: PromptFormat): string`
- `buildContextBlock(context: Record<string, string>, format: PromptFormat): string`

#### Active-context date and the member timezone setting

The active-context block appended to every launched agent prompt (`withActiveContext` in `@workbench/prompts`, called by the sidecar's `default-harness.ts` at build time) renders `Current date:` in the member's timezone with an explicit zone label — e.g. `Tuesday, July 14, 2026 (America/Los_Angeles)` — never a silent server-local date. The zone is an explicit member setting (`timezone` in the preferences registry, `packages/workbench-shared/src/preferences-registry.ts`), stored in the `member_preferences` jsonb like every other member setting and edited on the Settings page (the UI prefills the browser's zone as a suggestion when unset; nothing is saved until the member confirms). The builders stay pure — `now` and `timeZone` are arguments. Transport: the launch config has no open metadata field (`HarnessConfig` is a closed upstream schema), so `launchAgentSession` stamps a `<!-- workbench:timezone=<zone> -->` control-plane marker onto the effective prompt — the same seam as the memory-seed marker — which the harness resolves off the raw base prompt and strips before the model sees it, formatting a fresh date per build. Fallback chain: stored member timezone → date labeled `(UTC)`. Unattended sessions (mailbox triage, invoked subagents) launch through the same wrapper and instance→member mapping, so they get the same stored zone.

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

**`packages/tools-exa`** (`@workbench/tools-exa`): Exa search API. Exports `EXA_HUB_TOOLS` with `exa_search` and a provider-agnostic `web_search` alias resolving to the same handler (providerName: `'exa'`). Both return normalized `ResearchItem[]` (`source: 'web'`); results without a publish date fall back to retrieval time tagged `provenance: 'degraded'` so they stay in-window but rank below dated, voted sources.

**`packages/tools-granola`** (`@workbench/tools-granola`): Granola notes API. Exports `GRANOLA_HUB_TOOLS` with `granola_list_notes`, `granola_get_note`, and `granola_list_folders` (providerName: `'granola'`). `granola_list_notes` paginates with `page_size` (default 10, max 30) and accepts `created_after`/`created_before`/`updated_after`/`folder_id` filters; `granola_list_folders` surfaces folder IDs for that `folder_id` filter.

**`packages/tools-firecrawl`** (`@workbench/tools-firecrawl`): Firecrawl v2 API. Exports `FIRECRAWL_HUB_TOOLS` with `firecrawl_scrape`, crawl start/status/active/errors/cancel/params-preview tools, batch scrape start/status/errors/cancel tools, `firecrawl_map`, `firecrawl_search`, extract start/status tools, `firecrawl_agent` (autonomous research via POST /agent), `firecrawl_parse` (document parsing), `firecrawl_interact`, `firecrawl_browser_sessions_list`, `firecrawl_browser_session_delete`, monitor CRUD (create/get/update/delete/list/run/check), `firecrawl_credit_usage`, `firecrawl_historical_credit_usage`, `firecrawl_token_usage`, `firecrawl_historical_token_usage`, and `firecrawl_activity` (providerName: `'firecrawl'`). Long-running endpoints return job IDs and require explicit polling tools.

#### last30days research workflow

Gathers the last 30 days of cross-platform signal (per-fan-out grounded queries →
serial source fetches → relevance-floored brief → long-form write) and saves a
cited `research` artifact. Detail lives with the code:
[`workflows/last30days-research/README.md`](../workflows/last30days-research/README.md)
(steps, serial chain, per-step models),
[`packages/last30days-core/README.md`](../packages/last30days-core/README.md)
(pipeline + `buildReport`/`minRelevance`), and
[`packages/tools-last30days/README.md`](../packages/tools-last30days/README.md)
(the core/grounding/brief tools).

### `packages/chat` (`@workbench/chat`)

Transport-agnostic chat UI for Myra and workspace agents — no WebSocket or hub client dependency.

| Area                       | Modules                                                                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer                   | `ChatInput.tsx`, `attachments.ts`, `composer-voice-dictation.ts`           | File picker, drag-drop, clipboard paste (`filesFromClipboard`), attachment validation chips; optional Web Speech dictation with auto-send on stop. Draft-and-queue while busy (CL-2988, below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Message chrome             | `MessageBubble.tsx`, `messageRhythm.ts`, `AgentTurn.tsx`                   | One `AgentTurn` = single `ActivityBlock` (reasoning + tools) then response; feedback anchored to the response. Shared trace spacing/typography; rhythm tokens reference repo-root [`DESIGN.md`](../DESIGN.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Activity block             | `ActivityBlock.tsx`, `reasoning-summary.ts`, `reasoning-expanded-prefs.ts` | Single collapsible per turn, collapsed by default; rolling one-line summary while streaming via `rollingReasoningLabel` (low-signal fragments filtered/deduped); per-turn expand persisted in `localStorage` (`cw-myra-reasoning-expanded`). `ReasoningDisclosure.tsx` remains for standalone reuse. **Only rendered for a live turn** — once every segment of a turn settles, `ChatThread` projects the turn to outputs-only (see below) and no activity block renders at all.                                                                                                                                                                                                                                                                                                                                                                                               |
| Outputs-only settled turns | `settled-turn-projection.ts`                                               | groups a turn's committed-segment agent messages by the additive `turnId` group key `composeChatMessages` stamps per exchange (`packages/agents` — segments and the live streaming bubble share the key; agent-initiated mail gets none, so it can never merge with a reply) and, once every segment has settled, projects the group to the final answer text, any segment carrying an embedded ```ui block, and files/attachments from any segment. Reasoning, tool calls, and interstitial narration ("Let me look up X…") segments are dropped — chat shows outputs, not process. A group with a failed segment renders segment-by-segment instead (the error state is member-actionable). Escape hatch is a subtle per-turn "View trace" link (`AgentTurn`'s `traceHref`, resolved via `ChatThread`'s `getTurnTraceHref`) to Insights → Trace. Live turns are unaffected. |
| Tools                      | `ToolNarrative.tsx`, `compactMessages.ts`, `CollapsedGroup.tsx`            | Single tool-row treatment for all states; truncated titles get a `title` tooltip + click-to-expand; failures surface the provider error inline (`tool-row-error`). Humanized summaries via `@workbench/agents` `friendly-tool-summary`; aged threads compact consecutive `kind: "tool"` messages; web adds provider logos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Shell                      | `ChatPanel.tsx`, `ChatThread.tsx`, `FloatingChat.tsx`, `DockedChatBar.tsx` | Docked and full-page chat hosts consume the same components.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Composer draft-and-queue (CL-2988).** `ChatInput.tsx` splits the old single `disabled === true || busy === true || sending` gate into two: `hardBlocked` (`disabled` only — a genuinely unusable session) blocks the textarea, the attach control, paste, and drag-drop; `busy` no longer blocks any of them. Submitting while `busy` pushes `{ id, text, attachments }` onto a local `queue` array and clears the composer instead of calling `onSend`; a `wasBusyRef`-gated effect fires exactly once per `busy: true -> false` transition and dispatches the oldest queued item via `onSend` (FIFO — a queue with more than one item drains one per subsequent turn). Each queued item renders as a chip (`QueuedMessageChip`) above the input with **Edit** (restores it into the current draft/pending-attachments and removes it from the queue) and **Cancel** (drops it). Two edge cases are handled deliberately: if the turn ends while the composer has gone `hardBlocked` (e.g. the session disconnected), the auto-send effect does not fire — the queued item is held until the composer is usable again; if the auto-sent item's `onSend` call rejects, the item is pushed back onto the front of the queue (never dropped) and the rejection surfaces through the same `errors` state a normal failed send uses. `onSend`'s existing `void | Promise<void>` contract is unchanged — the queue path uses the same promise handling as a direct submit.

**Persistence seam with `@workbench/agents`.** Live chat state is not stored in React context long-term: `composeChatMessages` rebuilds visible history from session events on each hub update (`apps/web/src/hooks/use-myra-session.ts`, `AgentChat.tsx`). Reasoning prefs and (separately) feedback ratings are client-owned keyed by message id / `feedbackId`. After hard reload, event replay reproduces bubbles; prefs hooks reconcile ids when streaming → settled mail.

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

| Method   | Route                                          | Input                                                                               | Output                           |
| -------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------- |
| `GET`    | `/agents`                                      | `?tenantId=...`                                                                     | `{ data: AgentInstance[] }`      |
| `DELETE` | `/tenants/:tenantId/credentials/:credentialId` | — (Interchange-native; manage grant created at write time)                          | `{ ok: true }` 200               |
| `POST`   | `/instances/:instanceId/sessions`              | `{}` (no credential IDs — Interchange resolves from agent's credentialRequirements) | `{ launched, launchError? }` 200 |

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

### Workflow Deploy and Run Routes

Workflows run on Interchange's native runtime; the hub deploys definitions and observes runs (no hub-routed step state machine). See [WORKFLOWS.md](./WORKFLOWS.md) for the authoritative execution-model deep-dive (single-supervisor + in-process child, the launch no-op knob, the hub-RPC tool rail, vendored surface), plus ARCHITECTURE.md § Native Workflow Runtime and [DEPLOYING_WORKFLOWS.md](../DEPLOYING_WORKFLOWS.md).

| Method | Route                                        | Input         | Output                                 |
| ------ | -------------------------------------------- | ------------- | -------------------------------------- | --------------------------------------------- |
| Method | Route                                        | Auth          | Input                                  | Output                                        |
| ------ | -------------------------------------------- | ------------- | -------------------------------------- | --------------------------------------------- |
| `POST` | `/api/internal/workflows/deploy`             | service token | serialized `@intx/workflow` definition | `{ kind, deploymentId, result }`              |
| `GET`  | `/api/v1/workflow-runs`                      | user session  | —                                      | `[{ deploymentId, kind, status, createdAt }]` |
| `GET`  | `/api/v1/workflow-runs/:deploymentId/stream` | user session  | — (SSE)                                | `data: { seq, runId, event: WorkflowEvent }`  |
| `POST` | `/api/v1/workflow-runs/:deploymentId/signal` | user session  | `{ runId, signalName, payload }`       | `202 { accepted: true }`                      |
| `GET`  | `/recent-calls`                              | user session  | `?tenantId&kind`                       | `{ calls }`                                   |

**Deploy** (`apps/hub/src/routes/workflow-deploy.ts`) — service-token-gated. Validates the posted definition, resolves the tenant deploy config, and runs the `@intx/workflow-deploy` orchestrator via `apps/hub/src/services/workflow-deploy.ts` (`createWorkflowDeployService` → `deployWorkflow`, defined at `workflow-deploy.ts:185`; orchestrator built at `:337`, run at `:359`). The service writes `workflow.json` + `capability-declarations.json` to a git-backed `workflow` repo and sends the multi-step deploy frame to the sidecar (`toSendMultiStepDeploy` over `SidecarRouter`; the `as AgentDeployWorkflow['definition']` cast reflects only exactOptional variance — see AGENTS.md § Vendored workflow-host wiring). The orchestrator's reference model launches a session per step (`interchange/packages/workflow-deploy/src/orchestrator.ts:489-500`), but the hub builds a `noLaunchAgentIds` set (`workflow-deploy.ts:227-231`) so `toLaunchSession` (`:1134-1144`) **no-ops** the launch for inline-inference (CL-2251) and deterministic-tool (CL-2252) steps; only deployed reasoning steps still launch. Each deployed step's `state/grants.json` is written into its agent-state repo by `writeStepGrantFiles` (`:1026`, called at `:259`). Pushed via the admin CLI's **Workflows → Push (deploy) a workflow** (which spawns `apps/hub/bin/deploy-workflow.ts` internally; see [ADMIN_CLI.md](./ADMIN_CLI.md)), which imports `@workbench/workflow-<kind>`, serializes its `workflow`, and POSTs it with `HUB_SERVICE_TOKEN`.

Run-start is `POST /workflow-exec/:kind/start` (`workflow-run-records.ts:228` → `startWorkflowRun`, `apps/hub/src/workflow-executor/run-exec.ts:212`), which inserts a `provisioning` run row and returns immediately, then provisions a **per-run** ephemeral deployment off the critical path (`provisionRunDeployment`, `workflow-deploy.ts:403`, CL-2582/CL-2755 async start).

**Run routes** (`apps/hub/src/routes/workflow-runs.ts`):

- `GET /api/v1/workflow-runs` — tenant index from the `workflow_run` table (`deploymentId IS NOT NULL`, non-deleted).
- `GET /api/v1/workflow-runs/:deploymentId/stream` — SSE over the run's native `WorkflowEvent` log via `subscribeKind(repoStore, principal, { kind: 'workflow-run', id: deploymentId }, ...)`. Emits the 17 on-disk event types (`RunStarted`, `StepStarted`, `StepCompleted`, `StepFailed`, `SignalAwaited`, `SignalReceived`, `RunCompleted`, `RunFailed`, `RunCancelled`, …).
- `POST /api/v1/workflow-runs/:deploymentId/signal` — HITL approval; delivers via `sidecarRouter.sendSignalDeliver` at `deriveDeploymentAddress(...)` (from `@intx/workflow-deploy`).
- `POST /workflow-exec/:kind/start` (`workflow-run-records.ts:228`) — **wired**: seeds the `provisioning` `workflow_run_record` row, provisions a per-run deployment (`provisionRunDeployment`, CL-2582), and triggers the run. The older `POST /api/v1/workflow-runs/:kind/start` (`workflow-runs.ts`) is an unused parallel route.
- `GET /workflow-exec/runs/:runId/state/stream` (`workflow-run-records.ts:692`) — **the primary live run UI surface**: an SSE stream that re-folds the run's log server-side and emits the authoritative `RunState` on connect and on every event (CL-2727). It replaces the fixed-interval poll of `GET /workflow-exec/runs/:runId/state` (`:584`); the web consumer (`apps/web/src/lib/workflow-run-state-stream.ts`) landed in CL-2779.

#### Workflow definition packages

Each kind is a package under `workflows/<kind>/` named `@workbench/workflow-<kind>`, exporting `kind` + `workflow` (`defineWorkflow` with deployed `defineAgent` / `inlineInferenceStep` / `deterministicToolStep` steps and `awaitSignal` HITL gates; the step classes live in `packages/agents/src/deterministic-step.ts`). Shipped kinds (the `workflows/` directory): `ab-compare-quality`, `ab-compare-speed`, `ab-compare-standard`, `attio-task-agent`, `gamma-presentation-creator`, `last30days-research`, `pain-point-collateral`, `reddit-opportunity-scanner`, `smoke-test`. The hub imports none of them — its only workflow imports are `@intx/workflow-deploy` (the orchestrator) and the `WorkflowDefinition` _type_ from `@intx/workflow`. Adding a kind is a new package + a push.

#### Web run console

The web client subscribes to the run-state SSE stream via `use-workflow.ts` (`apps/web/src/hooks/use-workflow.ts:298` builds the `/workflow-exec/runs/:runId/state/stream` URL; consumer in `apps/web/src/lib/workflow-run-state-stream.ts`) and receives the server-folded `RunState` directly. A run renders as UIBlocks in the chat dock: `WorkflowDock` (`apps/web/src/components/WorkflowDock.tsx:366`) renders `UIBlockView` over blocks built by `apps/web/src/lib/dock-block-builders.ts` — each migrated workflow package supplies its own builder; unmigrated kinds fall through to the generic `dockRunBlocks` synthesis (`packages/blocks/src/run-dock-blocks.ts`, the strangler fallback). The run page renders the same blocks: `WorkflowRunPane` (`apps/web/src/components/WorkflowRunPane.tsx`) loads a per-kind `Panel` when the package ships one, else falls through to `WorkflowRunBlocks` — which builds blocks with the same `buildDockBlocks` registry and POSTs the same resume shapes as the dock, so a gate renders and resumes identically on both surfaces. Gate block kinds (`choice` / `form` / `multiSelect` / `reviewList`) are defined in `packages/blocks/src/ui-block.ts` (`reviewList` at `:257-282`, CL-2759). A result block kind — `comparison` — carries a `@workbench/ui` `ComparisonResult` plus a run-level `status` (`running` / `final`); `UIBlockView` dispatches it to the shared `ComparisonView` grid, the single renderer for both the live A/B run and the saved artifact (`CompareBody`). The ab-compare presets emit ONE `comparison` block for the whole run — not N document blocks — deriving each lane's `streaming` / `responded` / `no-response` status so a streaming cell becomes responded in place (a lane that never answers keeps its slot as a gold "No response" marker; the survivor count is the only count shown, never a failure tally); the winner accent is withheld until `status` is `final`. Because the block set is recomputed in place per frame, `WorkflowRunBlocks` keys blocks with a stable `blockKey` (the comparison block is a singleton, gates key by signal) so the one comparison block streams its variants without remounting (CL-3099).

#### Sidecar workflow-host

The sidecar drives runs via the vendored workflow-host wiring plus the vendored `@workbench/workflow-host` package (see AGENTS.md § Vendored workflow-host wiring and [WORKFLOWS.md](./WORKFLOWS.md) § The vendored surface):

- `apps/sidecar/src/workflow-host-wiring.ts` — `deployMultiStep` (`:1049`) constructs **one** supervisor (`:1232`) and spawns **one** `workflow-child` subprocess (`:1393`; `Bun.spawn` at `:410`) per deployment.
- `packages/workflow-host/src/child/run-child.ts` — `runWorkflowChild` (`:510`) drives all steps **in-process** in the child via an in-process `invokeStep` (`:1329`). Each step's agent is built on demand (`packages/workflow-host/src/adapters/step-invoker.ts:337` → `createAgent`, `:345`) from `workflow.json` + grants + the agent DB row — no per-step session launch.
- `apps/sidecar/src/step-tool-harness.ts` — the workbench's **own** step-tool implementation (replacing interchange's `step-agent-tools.ts`, which is not run here — only a dead reference remains at `workflow-host-wiring.ts:166`). A step fetches its tool manifest + tarballs at run time over the hub-RPC rail (`fetchStepToolManifest`, `:113` → `POST /api/internal/tools/manifest`, `apps/hub/src/routes/tool-manifest.ts:68`, gated on the persisted `agent` row at `:80-84`) and resolves credentials via `/api/internal/tools/credentials` (`tool-credentials.ts:63`).
- `apps/sidecar/src/workflow-substrate-factory.ts` — builds the per-child substrate and `createSidecarStepInvoker` (`:888`). It dispatches by the step agent's `workbench.stepKind` tag: `deterministic-tool` → `runDeterministicToolStep` (`:1020-1026`, tool called directly, no reactor/inference), `inline-inference` → a bare `createAgent` inference (`:1035`), and every other (deployed) step → the real tool-capable agent harness.
- `apps/sidecar/src/workflow-run-pack-client.ts` — pushes the workflow-run event pack to the hub after each supervisor write (carries the CL-2340 delta-cursor/size-ceiling WORKBENCH-LOCAL block).

See `docs/DEPLOYING_WORKFLOWS.md` § Deterministic (non-inference) steps for the authoring patterns, step-output shapes, and current selector-DSL limitations (no rename/templating selector, no `map`+deterministic dispatch) that keep gamma `render` and ab-compare presets `persist` as agents.

#### Supervisor restart re-establishment (CL-2221/2224/2225)

A multi-step supervisor's mail address is registered only in the hub's in-memory `addressIndex` at deploy time (`sidecar-handler.ts` `sendAgentDeploy`) and is never re-advertised by the sidecar on register/reconnect — supervisors never call `startSession`, so they are absent from `restoreSessions`. A hub restart or sidecar bounce therefore drops the address and a later run-start/signal hits `agent is unreachable`. The hub re-establishes it from its own durable state (no sidecar self-restore):

- `WorkflowDeployService.ensureDeploymentRoutable` (`apps/hub/src/services/workflow-deploy.ts`) — idempotent (no-op when `getRoutableAddresses()` already includes the address) and coalesced per `deploymentId`. On a miss it reads `workflow.json` back via `readWorkflowDefinition` (working-tree read; `writeTree` materialized the file on the durable data dir), rebuilds config for the **existing** `deploymentId` (`assembleWorkflowDeployConfig`), and re-sends **only** the supervisor frame via `buildSupervisorDeployFrame` → `sidecarRouter.sendAgentDeploy`. It deliberately does **not** drive `orchestrator.deployWorkflow`: that re-launches every step session, and a step's trivial-branch `provisionAgent` throws `Agent already exists` for the still-present steps (they self-restore on a sidecar restart / stay alive on a hub restart).
- `apps/hub/src/routes/workflow-runs.ts` — the run-start and signal handlers `await ensureDeploymentRoutable` before delivering, so a trigger/signal never dead-ends (returns 500 if re-establishment genuinely fails).
- `apps/hub/src/services/workflow-reconciler.ts` — under per-run deployment (CL-2582), `reconcileAll` re-establishes supervisors from **non-terminal `workflow_run_record` rows** (the per-run `deploymentId` lives on the record, not on `workflow_run`; the deploy principal is recovered from the kind's registry row), on hub startup and on each sidecar `agent.reconnected`, single-flight-guarded and best-effort. `failOrphanedRuns` fails only interrupted `running` runs, never `awaiting` (CL-2575). `reclaimOrphanedDeployments` is a crash-orphan janitor — recently-terminal records whose deployment still has live `ins_<deploymentId>` instance rows are torn down (normal terminal teardown fires from the projection bridge; this catches a hub crash between the terminal save and teardown).
- `deployMultiStep` (`apps/sidecar/src/workflow-host-wiring.ts`) is idempotent: a re-deploy of the same address whose `definitionHash` matches the live supervisor short-circuits (returns the existing principal pubkey, no second `workflow-child` spawn); a different definition for a live address fails closed (every redeploy mints a fresh `deploymentId`→address, so same-address-different-definition is a contract violation).

**Limitation — paused runs don't resume across a restart.** Within one supervisor lifetime an `awaitSignal` gate resumes normally on signal, but a run parked at `awaitSignal` when the supervisor process dies cannot be resumed: the child's self-discovery (`workflow-host/src/child/self-discovery.ts`) replays the full log into `runWorkflow`, which throws `RuntimeResumeUnsupportedError` for an `awaiting-signal`/`awaiting-timer`/`in-flight` step (`interchange/.../runtime/run.ts:244-257`), and the rejection is swallowed without a terminal event (`run-child.ts:460`) so the run wedges. The hub machinery above re-establishes the supervisor so new runs work and resume works end-to-end once the upstream runtime re-arms awaiting-signal steps on resume — tracked in **CL-2226**.

#### Sidecar deployment reclamation (CL-2231)

A deployment's sidecar footprint — the supervisor's working-copy `workflow-run` repo (`<SIDECAR_DATA_DIR>/workflow-runs/<slug>`) plus each step's agent-state repo (`<dataDir>/agents/<id>`) and session agent dir — was never reclaimed, so repeated redeploys (deployment churn) accumulated orphaned git repos until the volume hit `ENOSPC` by **inode exhaustion** (not bytes; ~69MB but thousands of files). Two parts close this, both sidecar-local and never mutating hub state (the hub is the immutable source of truth):

- **Undeploy reclaim** (`apps/sidecar/src/workflow-host-wiring.ts`): at deploy the supervisor map entry records its `ownedDirs` (workflow-run repo + per-step agent-state/agent dirs, all from the sidecar's own `getRepoDir`/`SIDECAR_DATA_DIR`); the `undeploy` hook `fs.rm`s them after `supervisor.shutdown()`. Best-effort, idempotent, multi-step only, never throws. Covers the case where the supervisor is still in the in-memory map (live undeploy / supersede).
- **Boot reconciler** (`apps/sidecar/src/boot-reconciler.ts`, wired in `apps/sidecar/src/index.ts` before `orchestrator.start()` so interchange's `restoreSessions` never re-establishes orphans): fetches the live set from the read-only hub endpoint `GET /api/internal/deployments/live` (`apps/hub/src/routes/internal-deployments.ts`, sidecar-token gated, mirrors the internal tools routes; shared schema in `packages/tool-credentials`), then prunes only dirs whose embedded `ses_<32hex>` deployment-id **token** is absent from the live set. Matching is on the token, not exact dir names, so every id form a live deployment produces (agent-state repo id, sanitized address, supervisor dir, workflow-run slug) is provably kept. It also reclaims durable conversation mirrors under `<SIDECAR_DATA_DIR>/agent-conversation-state/<workflowRunSlug>/` when their deployment token is no longer live; live deployments keep those mirrors even with no active run, preserving warm-agent resume semantics. **Fail-safe by construction**: any fetch error / non-200 / non-JSON / validation failure / empty-live-set-with-tokenized-sidecar-state deletes **no tokenized sidecar dirs**; a dir with no extractable token is always kept; `cache`/`assets`/`.sidecar-signing` are never candidates. Interim operator reclaim is a sidecar restart, which runs this sweep before session restore; there is intentionally no hub-to-sidecar delete RPC for these local mirrors.

Residual: _live_ step-agents still re-establish on boot and get `Reconnection rejected by governance` (interchange `restoreSessions` re-advertises them; bounded, benign — steps are re-provisioned per run). The real cure is removing per-step deployed agents — the **CL-2232** spike (inline `@intx/agent` inference).

**Vendored-file hazard:** the undeploy-reclaim logic lives in `apps/sidecar/src/workflow-host-wiring.ts`, which is re-synced verbatim from interchange's reference sidecar wiring on every interchange pin bump (see AGENTS.md § Dockerfile Maintenance → vendored workflow-host wiring). Re-apply the reclaim block (and its `sanitizeAgentAddress` helper) after each re-sync; the `*-undeploy-reclaim.test.ts` suite guards it.

### Skill Library

| Method   | Route                              | Input                                                                          | Output                                      |
| -------- | ---------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| `GET`    | `/skills`                          | `?tenantId=...`                                                                | `{ skills: SkillItem[] }` (access-filtered) |
| `GET`    | `/skills/share-targets`            | `?tenantId=...`                                                                | `{ targets: { tenantId, name }[] }`         |
| `GET`    | `/skills/:assetId`                 | `?tenantId=...`                                                                | `{ skill: SkillItem, files: SkillFile[] }`  |
| `GET`    | `/skills/:assetId/versions`        | `?tenantId=...&limit=&offset=` (limit default 20, max 100)                     | `{ versions: SkillVersion[], total }`       |
| `POST`   | `/skills`                          | JSON `{ name, text, description?, scope? }` or multipart files (`scope` field) | `{ skill: SkillItem }` 201/200              |
| `POST`   | `/skills/:assetId/restore`         | JSON `{ sha }`                                                                 | `{ skill: SkillItem }` 200                  |
| `DELETE` | `/skills/:assetId`                 | `?tenantId=...`                                                                | `{ ok: true }` 200                          |
| `POST`   | `/agents/:agentId/skills/:assetId` | `?tenantId=...`                                                                | `{ agentAsset }` 201                        |
| `DELETE` | `/agents/:agentId/skills/:assetId` | `?tenantId=...`                                                                | `{ ok: true }` 200                          |

**`SkillItem`**: `{ id, name, displayName: string | null, createdAt, updatedAt, scope: 'private' | 'tenant', accessTenantId: string, ownerUserId: string | null, ownerName: string | null }` — `name` is the kebab asset name; `displayName` is the human label; `scope`/`accessTenantId` describe sharing; `ownerName` is resolved by joining the `user` table on `owner_user_id`.

**`SkillVersion`**: `{ sha, shortSha, version, message, authorName, createdAt }` — `version` is the sequential number (v1 = oldest); `shortSha` is the 7-char git oid.

**`SkillFile`**: `{ path: string, content?: string }` — `content` is absent for binary files. `path` is relative to the `<assetName>/` prefix (e.g. `SKILL.md`, `examples/demo.md`).

**Access metadata** — hub-owned `skill_access` table (`apps/hub/src/db/schema.ts`, migration `0026`): `{ assetId (PK), scope, ownerUserId, ownerPrincipalId, createdAt }`. No FK to `asset` (Interchange-owned), so `deleteSkill` clears the row explicitly. Types are defined with arktype (`skillItemSchema`, `skillVersionSchema`, `skillAccessScopeSchema`).

**Service** — `apps/hub/src/services/skill-library.ts`:

- `buildSkillBundle(files)` — validates paths (path traversal rejection, junk file filter), enforces 20 MB / 200 file limits, picks an entrypoint (`SKILL.md` preferred), computes a content checksum
- `buildSkillTree(assetName, description, bundle, fileContents)` — maps bundle files to `<assetName>/` tree paths, synthesises YAML frontmatter for the entrypoint (required by Interchange's `skillKindHandler`)
- `isSkillVisible(row, viewer)` — pure access rule (ancestor-chain membership + tenant/legacy/private-owner); drives `listSkills`/`getSkillAsset` filtering
- `canManageSkill(row, actor)` — pure ownership rule for delete/update/restore: stable user id when an access row exists, else the creator principal (legacy). `loadManageableSkill` resolves the asset across the ancestor chain and applies it (404 not-visible, 403 not-owned)
- `listSkills`/`getSkillAsset` — take a `{ tenantId, userId }` viewer, join `skill_access` + `user`, filter via `getAncestorChain` + `isSkillVisible`
- `listShareTargets(db, userId, tenantId)` — ancestor tenants the user is an active member of, closest first
- `createSkill` — calls `AssetService.createAsset` then `populateAsset`, then writes the `skill_access` row; catches `AssetServiceError { reason: 'duplicate_asset' }` → `SkillLibraryError` (409)
- `toVersionEntries(commits)` / `listSkillVersions` — git log → absolutely-numbered version entries (v1 = oldest), paginated (`{ versions, total }`, newest first); `SkillDetail` pages with a "Show older versions" control. `excludeRepoInitCommit` drops Interchange's genesis `"Initialize repository"` commit so a fresh skill starts at v1, not v2
- `restoreSkillVersion` — reads the tree at a commit and re-commits it to `refs/heads/main` (creator-only)
- `getSkillContent` — `git.walk` over `refs/heads/main`; returns `undefined` from `map` for directories (descent) and `null` only to hard-prune; strips frontmatter from `SKILL.md` before returning
- `deleteSkill` — deletes `asset` row (cascades `agent_asset`) and the `skill_access` row, then `fs.rm` the git repo dir; logs but does not throw on fs failure

**Frontend** — `apps/web/src/hooks/use-skills.ts`:

All skill hooks live here (`useSkillLibrary`, `useSkillDetail`, `useCreateSkill`, `useDeleteSkill`, `useSkillShareTargets`, `useSkillVersions`, `useRestoreSkillVersion`). `use-workflow.ts` re-exports them for backward compatibility. ArkType schemas validate API responses at the boundary; `useCreateSkill` threads the chosen `scope`.

**Detail page** — `apps/web/src/pages/SkillDetail.tsx`:

- Builds a `TreeNode` tree from the flat `files` array; renders a collapsible sidebar tree with `TreeItem`
- Auto-selects the first file (`selectedPath ?? files[0]?.path`)
- Renders `SKILL.md` through `react-markdown` with a source/preview toggle (bottom-left corner)
- Version-history panel (`useSkillVersions`): newest-first list with `v{n}`, short sha, author, date; current version flagged, others offer Restore via `useRestoreSkillVersion`
- Inline delete: "Delete" → confirm/cancel buttons → `mutateAsync` → navigate to `/skills` on success; surfaces errors inline without swallowing them

**Upload page** — `apps/web/src/pages/SkillsNew.tsx`: when `useSkillShareTargets` returns more than one tenant, a "Who can access this skill?" radio set lets the user pick which one; with a single target the chooser is hidden and that tenant is used. Create is always `scope: 'tenant'` with the selected `tenantId`. (The "Just Me"/`private` path was dropped pending a personal-tenant story; the backend `private` scope remains unused.)

**Library page** — `apps/web/src/pages/SkillsLibrary.tsx`: cards show owner, last-edited date, and an access label (`Private` or the resolved share-target tenant name).

**Routing** — `/skills` (library), `/skills/new` (upload form), `/skills/:id` (detail + delete)

### Search

| Method | Route                           | Input       | Output                                            |
| ------ | ------------------------------- | ----------- | ------------------------------------------------- |
| `GET`  | `/api/tenants/:tenantId/search` | `?q=&page=` | `{ results: PaletteResultItem[], page, hasMore }` |

Tenant-scoped aggregate palette search (see § Command Palette and UI Components). Mounted behind Interchange's `resolveTenant`; every source is filtered by `tenant_id`. Per-source limit 5 at `OFFSET page*5`; relevance ordered exact > prefix > contains, tie-broken by recency.

### Health

| Method | Route     | Output                              |
| ------ | --------- | ----------------------------------- |
| `GET`  | `/health` | `{ status: "ok", service: string }` |

## Database Schema

### Artifacts

The `artifact` table is the single store for all workflow and agent outputs.

- `id` (UUID, primary key)
- `kind` (text — workflow collateral kinds such as case-study, one-pager, email-draft, call-document, plus agent-authored kinds such as `web` and `web_site`)
- `sessionId` (UUID, foreign key, **nullable** — workflow-level artifacts have no session)
- `workflowId` (UUID, foreign key, nullable — links to a `workflow_run` for run-scoped artifacts)
- `content` (text)
- `createdAt` (timestamp)

**Web deliverables.** `kind=web` stores a single HTML document (previewed in `apps/web` via `ArtifactBody`). `kind=web_site` stores a JSON bundle validated by `WebSiteContentSchema` in `@workbench/workbench-shared` (`packages/workbench-shared/src/web-site.ts`): relative paths, optional `entry` (default `index.html`), per-file and total byte limits. Hub `artifact_*` tools normalize and validate `web_site` on create/write; `artifact_read` returns a summary or one file via optional `path`. **Publish:** Myra calls hub-backed `vercel_deploy_artifact` (`apps/hub/src/tools/vercel-deploy-artifact.ts`), which expands `web` / `web_site` content and posts files through `deployStaticFilesToVercel` (`@workbench/tools-vercel`). Tenant `vercel` credentials resolve at hub execution time (not in agent `credentialRequirements`). The sidecar approval gate blocks both `vercel_deploy_static_file` and `vercel_deploy_artifact` before the hub RPC runs.

**CSV table viewer.** `ArtifactBody` renders CSV as a table via a hand-rolled RFC 4180 parser in `@workbench/artifact` (`parseCsv`, `parse-csv.ts` — no dependency; it is the read-side inverse of the hub's `insights-csv-export` escaper). `kind=csv-export` has its CSV inline in `artifact.content`, so `CsvExportBody` parses and renders it directly alongside the download link. Uploaded `.csv` files land as `kind=file` with empty `content` (bytes in the `upload` table); they are detected **at render** by `source.upload.mimeType === "text/csv"` or a `.csv` filename (no upload-time kind change, no migration), and their bytes are fetched from `GET /artifacts/:id/download` via the `useArtifactCsvPreview` TanStack Query hook, degrading to a download link plus a "Preview unavailable — download to view" line on fetch failure. `CsvTable` (`apps/web/src/components/CsvTable.tsx`) keys rows and columns by index (CSV headers may be empty or duplicated), memoizes the parse, and caps rendering at both `CSV_TABLE_ROW_CAP` (500 rows) and `CSV_COLUMN_CAP` (50 columns) with a combined "showing N of M rows/columns" indicator since `DataTable` has no virtualization; the raw-text fallback is height-capped for the same reason.

Two layers keep a non-CSV or pathological payload from parsing into a garbage table or hanging the tab: (1) **`ParsedCsvSchema`** — an exported arktype schema (the source of truth; `parsedCsvIsTabular` delegates to it) whose narrow rejects a headerless or ragged parse, routing a non-tabular result deterministically to the raw-text fallback rather than relying on `parseCsv` "never throwing"; (2) **size ceiling** — `CSV_MAX_PREVIEW_BYTES` (2 MB, measured in true UTF-8 bytes via `utf8ByteLength`) is checked against the declared `Content-Length` (refused before the body is read) and the decoded length in `fetchCsvPreview` (`apps/web/src/lib/api.ts`), and against inline text in `CsvTable`, **before** `parseCsv` walks the string; over the cap the viewer shows a "too large to preview — download instead" state. There is deliberately **no Content-Type gate**: the download route echoes the stored upload mime, which for a real `.csv` is frequently a vendor mime (`application/vnd.ms-excel`, `application/octet-stream`, empty), so re-sniffing it would reject legitimate uploads; a genuine non-CSV file never reaches this fetch because routing (`isCsvUpload`) sends it to the plain `FileBody` download instead.

**Inline PDF preview for Gamma decks.** `GET /artifacts/:id/download` (`apps/hub/src/routes/artifacts.ts`) always serves an upload-backed artifact's bytes with `Content-Disposition: attachment` — user-supplied bytes must never execute inline on the app origin. That default made `GammaPresentationBody` (`apps/web/src/components/GammaPresentationBody.tsx`), which iframes the download URL when a Gamma deck carries a durable PDF (`hasPdf` + `artifactId`), render a silent blank box: browsers refuse to render an attachment inside an iframe, and no `error` event fires on the iframe for it, so the fallback message never showed. The route now honors `?inline=1` **only** when the stored `upload.mimeType` is exactly `application/pdf` — every other mime type stays `attachment` regardless of the param — and always sets `X-Content-Type-Options: nosniff` on this path. A PDF is safe to hand back inline because the browser's built-in PDF viewer is not a script-execution context, unlike an HTML or SVG attachment. `GammaPresentationBody` no longer relies on the iframe's error event: it first probes the inline URL with a credentialed `fetch`, mounts the iframe (with `sandbox="allow-same-origin"` — the minimal flag set that still lets Chrome's built-in PDF viewer render; a fully empty sandbox blocks it) only once the probe succeeds, and shows the existing "could not be loaded here" fallback on any probe failure. The plain (attachment) download URL is unchanged and still backs the "Download PDF" link.

### Workflow Run (`workflow_run`)

The generic, kind-agnostic run row. For natively deployed workflows it is the hub-side index into Interchange's native run; run state itself lives in the native `workflow-run` event log, not here.

- `id` (UUID, primary key)
- `deploymentId` (text, nullable) — the `@intx/workflow-deploy` deploymentId (`ses_…`) for natively deployed runs; null for legacy pipeline-session rows. The `GET /api/v1/workflow-runs` index filters on it
- `tenantId` (text), `principalId` (text)
- `kind` (text) — workflow kind
- `status` (text), `input` / `output` (jsonb, nullable)
- `createdAt`, `updatedAt`, `deletedAt` (timestamps)

### Enabled Workflows (`enabled_workflow`)

Tracks which workflow kinds a principal has enabled in a tenant.

- `id` (text, primary key)
- `tenantId` (text)
- `principalId` (text, NOT NULL) — the enabling member's principal
- `kind` (text) — workflow kind
- Unique `(tenant_id, principal_id, kind)` for idempotent upserts. Scoped per-principal so one member's enablement cannot overwrite another's in the shared root tenant.

### Mailbox, automations, and tasks

- `principal_mailbox` (migration `0046`, `message_key` added in `0050`) — the workbench-owned inbox for every principal (human or agent instance). `apps/hub/src/lib/principal-mailbox.ts` (`createPrincipalMailboxPersist`) provides the `persistMail` override that writes here instead of relying on Interchange's own mail persistence. `GET /me/inbox` is keyset-paginated (`{ limit, cursor }` → `{ messages, nextCursor? }`); `GET /me/inbox/:id` and `POST /me/inbox/:id/read` complete the surface. **Live delivery**: every successful mailbox insert (external mail, gate deliveries, triage handoffs — all funnel through `writeMailboxMessage` in `mailbox-write.ts`) publishes a content-free `{ type: "mailbox", id }` signal onto a per-principal in-process bus (`mailbox-events.ts`, keyed by principal with a `Set` per key for multi-tab); `GET /me/inbox/events` streams it over SSE, and the web client invalidates its mailbox query on signal (`use-mailbox-live.ts`), keeping the 30s poll as a fallback. Publish is fire-and-forget after the insert succeeds — a subscriber failure can never break delivery. Address split and MIME header parsing are consolidated: `splitMailAddress`/`splitMailAddressList` (quoted display-name aware) live in `@workbench/hub-agent` (`mail-address.ts`), and `tryParseHeaderSection` (`apps/hub/src/lib/mail-headers.ts`) is the single header-parse wrapper.
- `scheduled_trigger` (migration `0047`) — durable per-user schedules fired by the daily scheduler (`apps/hub/src/services/scheduler.ts`) and seeded by `scheduled-trigger-seeder.ts` (one heartbeat schedule per Myra instance, at `scheduler.heartbeatHourUtc`). The scheduler requires an enablement predicate (feature grant, below) — the old static `enabled` flag is gone. Heartbeat payloads are enriched **at fire time** (`enrichHeartbeatTriggerPayload`): the member's `briefSource:*` preferences become `enabledSources`, and `createdAfter` is stamped from the schedule's last fire (24h fallback, clamped to 7 days) so day-2 briefs never re-brief the same Granola notes. Workflow schedules auto-deliver the `intake` gate when configured (CL-3509); multi-gate kinds with post-intake human gates require `ALLOWS_SCHEDULED_POST_INTAKE_DRIVE` on the workflow package (or test allowlist) before attach — see **Scheduled runs, intake, and post-intake gate drive** in [WORKFLOWS.md](./WORKFLOWS.md) (CL-3528 Myra gate agent, queue cap, stalled-run reconciler).
- `workflow_trigger` (migration `0048`) — user-owned webhook triggers. `/me/webhook-triggers` manages them; the public `POST /triggers/webhook/:triggerId` route authenticates with a SHA-256 secret hash and rate-limits per `(ip, triggerId)`, returning a generic 404 on any auth or rate-limit failure so triggers can't be enumerated.
- `task` and `task_external_ref` (migration `0049`) — native, workbench-owned tasks. `packages/tasks` holds the adapter registry, **Attio and Linear adapters** (the Linear adapter reuses `fetchLinearGraphQL` from `@workbench/tools-linear`, resolves the target team from a `linear:team:<id>` task link — throwing on ambiguous multi-team links — and maps status to per-team workflow-state _types_, never hardcoded state ids), and a push service that writes `task_external_ref` rows with a durable `actor_principal_id`; a failed push is retried server-side by the `tasksReconciler` (feature-grant gated) and never surfaces as a user-facing error. `POST /me/tasks/:id/push` lets a member send their own task to an adapter (ownership-checked, adapter validated against the registry); the web renders external refs as linked/sending chips (no error states in member-facing UI, by rule) and composes open tasks into the notifications bell. `/me/tasks` is keyset-paginated the same way as inbox and schedules, though its list field is `items` rather than `messages` — see `API.md` for the inconsistency. **Task link validation (CL-3524)** — `validateTaskLinks` in `packages/workbench-shared/src/task-links.ts` runs on `POST /me/tasks`, `createOwnerTask`, and the `task_create` agent tool. Allowed kinds: `artifact`, `workflow_run`, `mail`, `conversation`, `url` (http(s) only). **Callers:** mailbox triage and chat Myra via `task_create` (`apps/hub/src/tools/task-tools.ts`); triage sets `sourceRef` / `mail` links to the mailbox row id surfaced in the triage user message (`mailbox-triage.ts`, `packages/myra/src/personas/mailbox.ts`). The web client only PATCHes tasks (no create-with-links). Workflows do not call `task_create`. **Operator note:** Linear/Attio push still read legacy `linear:team:` / `attio:` hints from stored link `ref` values regardless of `kind`; new creates cannot use those strings as `kind: "url"` refs — omit links or use valid ids until adapter link kinds are extended.
- **Feature grants** — the automation kill switches are owner-managed grants, not env vars. `FEATURE_GRANT_CATALOG` (`packages/workbench-shared/src/governance.ts`) defines `feature:scheduler|triage|tasks-reconciler`/`enable`; `apps/hub/src/lib/feature-grants.ts` resolves enabled = env override OR tenant grant (written to the tenant's system member role), with a ~30s TTL cache and fail-closed-with-logging on grant-store errors. `GET/PUT /owner/features` (owner-guarded, `admin_audit`-recorded) backs the Features section on Owner → Capabilities; an env-forced feature renders as `forcedByEnv`. Checks run per-tick in the scheduler and reconciler and per-item at triage dequeue.
- **Owner role delegation (CL-3634)** — an owner can grant/revoke the `owner` system role for other tenant members through `GET /owner/members`, `POST /owner/members/:id/promote`, and `POST /owner/members/:id/demote` (`apps/hub/src/routes/owner.ts`, owner-guarded like every other `/owner/*` route). This reuses the exact native `principal_role`/`grant` assignment mechanism the existing admin elevate/demote surface uses — `assignRole`/`removeRole` in `apps/hub/src/services/admin-governance.ts` — no bespoke grant concept; a promotion is a `principal_role` row for the tenant's `owner` system role (the same role whose `*`/`*` wildcard grant the owner gate (`isOwner` in `apps/hub/src/lib/admin-grant.ts`) checks). Two guardrails are enforced server-side: the route rejects self-demotion (400) and `demoteFromOwner` refuses to remove the tenant's last remaining owner (400), row-locking the owner role (`SELECT ... FOR UPDATE`, mirroring the member-role lock in `feature-grants.ts`) so two concurrent demotes of the last two owners cannot both observe "count > 1" and leave the tenant ownerless. Both actions are audit-logged via `recordAudit` (`role_assigned`/`role_removed`, resource `role:owner`). There is no cache on the owner-grant resolution path (`isOwner` → `authorize` → `collectGrants` reads `principal_role`/`grant` directly), so a promote/demote takes effect on the very next request — nothing to invalidate. The web surface is a new Owner → Members tab (`apps/web/src/pages/admin/OwnerMembers.tsx`) listing members with an "owner" role badge and Make/Remove owner actions (confirm dialog before demote).
- **Inbox intake (CL-3577..3586)** — `apps/hub/src/services/inbox-intake.ts` (`createInboxIntake`) runs a 60s tick (`DEFAULT_TICK_INTERVAL_MS`, overridable via `INBOX_INTAKE_TICK_MS`) gated by the same `scheduler` feature grant used by the automations above. Every source is **default off** at the catalog level (`INBOX_SOURCE_CATALOG` in `packages/workbench-shared/src/preferences-registry.ts`, derived from `CREDENTIAL_PROVIDER_CATALOG` + `TOOL_CREDENTIAL_SUPPLEMENTS`'s `inboxSource` tag) — intake is strictly opt-in end to end. Two scopes:
  - **Member scope** (Linear, Attio): `apps/hub/src/services/inbox-sources/linear.ts` and `attio-task-sync.ts`, registered in the static `INBOX_SOURCE_REGISTRY` array (`inbox-source-registry.ts`). Gating order per member per tick: scheduler feature grant → member `inboxSource:<key>` preference → owner ceiling grant (`isWorkspaceInboxSourceEnabledForTenant` in `lib/workspace-inbox-source-gate.ts`, fail-closed on any error, never fails open) → OAuth capability opt-in for connectable providers → resolved member-or-tenant credential (missing credential = skip, logged, never stubbed) → lookback/backfill cutoff. Linear supports a one-time backfill window (`none`/`7d`/`30d`, `inboxSource:linear:backfill`) applied only on a member's first poll after enabling, marked via `inboxSource:linear:backfillAppliedAt` so later ticks use the normal 24h cutoff. The tick also tracks a per-scope `lastPollAt` cursor (keyed member/workspace × source) so steady-state polls fetch only since the last successful tick. A handler controls its own advance by returning `{ nextCursor }`: on a possibly-truncated page (full `perSourceLimit` page, or Granola's `hasMore`) it advances the cursor to the newest processed item's own timestamp (`occurredAt` for fetch-shaped sources, `created_at` for Attio/Granola) when one is available, so sustained overflow (`>= perSourceLimit` new items every tick) drains the backlog tick over tick instead of livelocking on the same re-fetched window — a source with no per-item timestamp falls back to pinning the cursor at the unchanged window and relies on dedupe to absorb the re-fetched overlap; a throw never advances. **Durable cursor + tick leadership (CL-3628)**: the cursor is persisted in Postgres (`inbox_intake_cursor`, migration `0058`, one row per scope key, `apps/hub/src/lib/inbox-intake-cursor.ts`) instead of the old in-process `lastPollAtByScopeKey` map, so a replica restart/redeploy resumes from the last successful poll instead of re-polling the full `lookbackMs` window. `createInboxIntake`'s `tick()` also wraps the whole pass in a Postgres session-scoped advisory lock (`pg_try_advisory_lock`, held on a dedicated reserved connection for the tick's duration) so exactly one replica runs a tick at a time; a replica that can't acquire the lock logs and no-ops, retrying next interval. The lock is skipped when the DB client has no `reserve()` (the PGlite driver the intake test suite runs against) — safe there because those tests never run concurrent ticks. Granola additionally walks up to `MAX_PAGES_PER_TICK` (4) list pages within one tick via the list API's own `cursor` when the response offers one, draining a multi-page backlog faster than one page per tick. Granola's duplicate-artifact path also re-attempts the (idempotent, per-recipient-deduped) mail fan-out, so a crash between artifact insert and fan-out heals on the next tick. Attio's task listing (`/v2/tasks`, offset-paginated, no `updated_at` filter) similarly walks up to `MAX_LIST_PAGES_PER_TICK` (10) offset pages per tick (CL-3630), stopping at the first partial page — that keeps `seenTaskIds` accurate for the full open set in the common case instead of just page 1, so `reconcileDeletions`'s individual `attio_get_task` 404-check only fires for tasks genuinely absent from the full listing. That re-verification is itself capped at `MAX_DELETION_CHECKS_PER_TICK` (25) per tick with the candidate window rotating by the tick's `since` timestamp, so a backlog larger than the cap is covered over several ticks rather than in one unbounded burst — the ambiguous-error-leaves-alone and never-revive-cancelled rules are unchanged.
  - **Workspace scope** (Granola): `granola-workspace.ts`, constructed at runtime and concatenated onto the static registry (`registry: [...INBOX_SOURCE_REGISTRY, createGranolaWorkspaceInboxSource(...)]`) because it needs the job queue injected. Gated by the same owner-ceiling grant, keyed `inbox-source:granola`; no per-member preference — a Granola call reaches a member only via the fan-out match below. **CL-3627**: the tick is enqueue-only — it lists notes and calls `queue.enqueue(tenantId, noteId)` on the durable `granola_call_job` table (migration `0057`, `granola-call-job-queue.ts`); it does **not** fetch the full note (transcript) or invoke the LLM turn, so a slow/failing Granola call no longer blocks the shared 60s tick loop. `enqueue` is idempotent per `(tenant_id, note_id)` (unique index) — a re-listed note upserts onto its existing row rather than duplicating work.
  - **Delivery**: both scopes funnel through `deliverInboxItems` (`lib/inbox-delivery.ts`), which writes via `writeMailboxMessage` with `messageKey = inbox:<sourceKey>:<externalId>` (upsert-dedupe) and unconditionally offers the row to mailbox triage (triage self-gates on its own feature grant).
  - **Webhooks** — `routes/webhooks-linear.ts` and `routes/webhooks-attio.ts` are optional low-latency companions to the poller, mounted only when `LINEAR_WEBHOOK_SECRET` / `ATTIO_WEBHOOK_SECRET` is set. Each verifies an HMAC signature over the raw body, applies a replay window, and reuses the **same externalId/sourceRef scheme** as its poller counterpart so a webhook delivery and a subsequent poll of the same event collapse into one mailbox row. `routes/webhooks-slack.ts` (mounted on `SLACK_SIGNING_SECRET`) is the same pattern for Slack mention intake; delivery is gated by the owner tenant cascade AND the member's own `inboxSource:slack` preference (default off — `INBOX_SOURCE_CATALOG` includes inbox-only sources via the `inboxSource` catalog tag, so Slack appears in member settings like Linear/Attio, minus the credential requirement). **Team routing (CL-3629)** — the webhook's `team_id` is resolved against `slack_team_tenant_mapping` (`lib/slack-team-mapping.ts`; migration `0056`), written by the owner Slack-enable path in `routes/owner.ts` via `fetchSlackTeamId` (`auth.test` on the tenant's bot token, `lib/slack-api-client.ts`) — replacing the earlier CL-3581 `firstEnabledTenant`/multi-tenant-scan approach, which only worked for a single Slack workspace per deployment. An event whose `team_id` has no mapping is dropped (still `200`, debug-logged) rather than routed to every owner-enabled tenant. This assumes one `SLACK_SIGNING_SECRET` verifies every mapped team (true for one distributed Slack app installed across workspaces); per-tenant signing secrets are out of scope here and tracked as follow-up.
  - **Granola call pipeline and fan-out** — `granola-call-pipeline.ts` (`createGranolaCallPipeline`) is idempotent per call (dedupes on `artifact.source->>'granolaNoteId'`, backstopped by the `artifact_tenant_source_ref_uniq` partial unique index from migration `0055`), requires a resolved Myra inference source (no source = `skipped-no-source`, never stubbed), deterministically classifies internal/external by attendee email domain (no LLM), and runs one reasoning turn to extract `summary/painPoints/decisions/actionItems/tasks/peopleMentioned` before persisting a `granola-call` artifact. `granola-call-fanout.ts` (`createGranolaCallFanout`) matches root-tenant Myra members to the call by participant or mentioned-person email (falling back to name only when the match is unambiguous), requires each matched member to have their Granola inbox capability enabled, and delivers one deduped mail per `(call, recipient)` containing only that recipient's items.
  - **Granola call job queue and runner (CL-3627)** — the LLM turn above no longer runs on the intake tick. `granola-call-job-queue.ts` (`createGranolaCallJobQueue`) owns the `granola_call_job` table (migration `0057`; one row per `(tenant_id, note_id)`, unique-constrained): `enqueue` upserts a `pending` row (dedupe backstop), `claimDue` atomically flips due `pending` rows (`next_attempt_at <= now()`) to `processing`, and `complete`/`fail` resolve a claim. A failed attempt reverts to `pending` with `next_attempt_at` pushed out by an exponential backoff (1 minute base, doubling, capped at 30 minutes) and is marked `dead` (not retried) once `attempts` reaches `MAX_ATTEMPTS` (8) — a permanently-broken note is logged loudly rather than retried forever or silently dropped. `granola-call-job-runner.ts` (`createGranolaCallJobRunner`) polls the queue on its own 15s interval (`DEFAULT_TICK_INTERVAL_MS`, independent of the 60s intake tick), claims a small batch (5) per pass, resolves the tenant's Granola credential (`resolveTenantToolCredential`), fetches the full note (transcript) via the `granola_get_note` tool, and hands it to the unchanged call pipeline — the pipeline's own artifact dedupe and fan-out messageKey dedupe make a retried or duplicate-claimed job safe to re-run.
  - **Owner and member surfaces**: `GET/PUT /owner/inbox-sources` (owner toggle, cascades to members — disabling hides the source from member settings without touching their stored preference; audit-logged) and `GET /me/inbox-sources` / `PATCH /me/preferences` (member toggle plus Linear's scope/backfill options) — see `API.md`. See `OWNER_SETUP_INBOX.md` for the operator walkthrough.

### Migration Sequence

| Migration     | Description                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0020_upload` | Adds the `upload` table (`id`, `tenant_id`, `principal_id`, `filename`, `mime_type`, `content` BYTEA, `size`, `created_at`) for pre-workflow binary files (xlsx) that arrive before a run exists |

> The native-runtime cutover added the `workflow_run.deployment_id` index column and removed the deleted custom-stack tables (`collateral_generation_workflow`, `workbench_user`) and the `workbench_workflows.assignments` column. See `apps/hub/migrations/` for the current sequence.

## Agent Architecture

### Credentials and Grants

#### Credential sources by agent

- **Personal agent (Myra)**: `source: 'tenant'`, `name: 'Myra LLM'` for openai-compatible inference — resolved down the root tenant's ancestor chain (org-level or per-workbench). The credential is stored tenant-owned (`principalId: null`) and created during onboarding. Each user has their own Myra agent definition in the root tenant, keyed on `(tenantId, creatorPrincipalId)`.
- **Granola agent (Oat)**: `source: 'tenant'` for both `granola` and `openai-compatible` — resolved against the workspace tenant

#### Creating credentials

Credentials are created by an org admin via **`@intx/admin-ui`** using Interchange's native `POST /api/tenants/:tenantId/credentials` route. The workbench product app has no credential creation UI.

**Credentials are always tenant-owned** (`principalId: null`). This is required for Interchange's `source: 'tenant'` resolution to find them at agent launch time.

Secrets are stored as plaintext at the application layer; encryption is handled at rest by the storage layer. The app reads secrets directly from the `credential` table and passes them to the sidecar without any decryption step.

For local dev, seed providers and credentials from env vars via the admin CLI's **Local actions → Seed tool credentials from env** (see Local Development).

#### What must not change

- **Do not `void` the call inside the reconnect listener.** `emitAndAwait` awaits the promise the listener returns. `void` detaches the async body, destroying the sequencing guarantee and causing the push to race with (and likely lose to) Interchange's encrypted push.
- **Do not reorder listener registration.** Our listener must be registered after `createHubSessionOrchestrator`.
- **If you add a new caller of `sidecarRouter.sendSourcesUpdate`**, verify it sends the credential secrets as read from the `credential` table (plaintext; no decrypt step required).

The reconnect bug has been fixed.

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

#### Route mounts

**Interchange-owned routes** (mounted automatically by `createApp` from `@intx/hub-api`, available at `/api/tenants/:tenantId/*`):

- `GET /api/tenants/:tenantId/credentials` — list credentials (used by frontend)
- `GET /api/tenants/:tenantId/principals` — list principals
- `GET /api/tenants/:tenantId/grants` — list grants
- All other tenant/principal/grant CRUD

**Workbench-owned routes** (in `apps/hub/src/routes/`, mounted under `/api/v1/`):

- `DELETE /api/tenants/:tenantId/credentials/:credentialId` — Interchange-native (manage grant created at write time enables this)
- `POST /v1/instances/:instanceId/sessions` — launch session for existing instance (no credential IDs; Interchange resolves from agent's credentialRequirements)
- `POST /v1/workspaces`, `GET /v1/agents`, etc.
- `GET /api/v1/tenants/:tenantId/approvals/stream` — SSE stream of workbench-owned approval **change notifications** (`created` / `resolved`), keyed by tenant. Carries only a change signal (`tenantId`, optional `sessionId`, `kind`) — never approval rows or tool-call arguments; the web `ReviewGate` refetches the ownership-scoped `GET .../approvals` list on each event instead of polling on an interval. Backed by an in-process pub/sub (`apps/hub/src/lib/approvals-events.ts`) injected into both the user-facing and internal approvals routers; the internal create route emits `created`, the approve/reject routes emit `resolved`. No `@intx/*` changes.
  - **Single-hub-replica scope.** The bus is in-process: emitter and SSE subscriber must share one process. The hub is deliberately single-replica (see the Railway deploy-overlap note), so this holds — **except during a deploy-overlap window** (~120s, two replicas live), when an approval created on replica A won't wake a stream pinned to replica B. It self-heals: the stream stays up, and the next event or the client's `refetchOnWindowFocus` backstop re-fetches. Scaling the hub past one replica permanently would silently drop cross-replica notifications — tracked as a follow-up to move the bus to a shared pub/sub before that ever happens.
  - **No fallback poll.** The interval poll was removed, so a terminally-failed SSE connection (never opens after the shared registry's retry cap) leaves the gate stale until the next window-focus refetch (TanStack's `refetchOnWindowFocus` default is the sole backstop). The terminal failure is surfaced to `onError` and logged rather than swallowed.

**Internal routes** (sidecarToken auth, mounted under `/api/internal/`):

- `POST /api/internal/approvals` — human approval callback from sidecar (ask_principal tool); emits a `created` notification on the approvals event bus
- `POST /api/internal/tools/run` — hub-proxied tool execution. Body: `{ tenantId, toolName, args }`. Hub resolves the tenant credential for the tool's provider from Interchange, calls the tool package handler, returns `{ result: string, isError: boolean }`. Credentials are decrypted before use; never stored in sidecar.

### Deploy Prompts

Agent deploy prompts are currently **static** (no dynamic context injected at deploy time). Dynamic context (current date, operator name, etc.) will be injected at session start via the hub-client layer — not yet implemented.

### Session Liveness and Relaunch

An instance is reachable for mail only when its row `status` is `running` — Interchange's session orchestrator sets this when the agent's session connects, and the mail route (`POST /tenants/:tenantId/agents/instances/:instanceId/mail`) returns `409` (`Instance is not running`) for any other status.

A hub or sidecar restart drops the in-memory agent — the sidecar re-registers "with 0 agents" — but leaves the DB rows behind: `agentInstance.status` stays `deployed` and the old `agentSession` row stays `active`. The session record is therefore **not** a reliable liveness signal across restarts.

`relaunchInstanceIfNeeded` (`apps/hub/src/routes/agents.ts`, called from `POST /v1/me`) gates on the live instance status, not the stale session record: it returns early only when `instance.status === 'running'`, and otherwise relaunches (subject to the tenant having an active credential). This is what brings Myra back automatically after a deploy or crash — without it, every `/mail` POST kept 409ing on a restarted instance.

The Myra chat (`apps/web/src/components/PersonalAgentChat.tsx`) also self-heals at send time: if `sendMail` throws an `ApiError` with status `409`, it calls `launchInstanceSession(instanceId)` and retries the send once. This covers the window between a restart and the next `/v1/me` relaunch, so a send during that gap heals rather than throwing and dropping the message. A genuine failure surfaces the recoverable error notice instead of crashing the panel.

#### Disconnect reconciler

Interchange's session orchestrator only abandons the in-memory event collector on `sidecar.disconnect`; it leaves `agentSession.status = 'active'` so a transient reconnect can resume. When a sidecar fully restarts (every redeploy) the previous address never re-registers, so the DB is left describing a live agent that no sidecar routes — and `relaunchInstanceIfNeeded` then returns early forever (an active session reads as "the harness owns it"), wedging the instance until its row is deleted by hand.

`registerDisconnectReconciler({ db, router })` (`apps/hub/src/routes/agents.ts`, wired in `apps/hub/src/index.ts` after `createHubSessionOrchestrator`) subscribes to `sidecar.disconnect`. For each disconnected address it waits a grace window (`DEFAULT_DISCONNECT_RECONCILE_GRACE_MS`, 90s — the host's bet on how long a genuine reconnect can take) and then calls `reconcileDisconnectedSession`. That function re-checks `sidecarRouter.getRoutableAddresses()`: if the address is routable again the sidecar reconnected and there is nothing to do; otherwise the agent is gone, so its non-`ended` session is marked `ended` (`status`, `endedAt`, `updatedAt`). Ending the stale session lets the next `relaunchInstanceIfNeeded` treat the instance as a cold start — so Myra auto-relaunches via `/v1/me` and other agents recover on next open, instead of staying wedged behind a phantom session.

#### Wedge-sweep reconciler

The disconnect reconciler only supplies the **end** half, and only when a `sidecar.disconnect` event is actually observed. It has two gaps: nothing proactively **relaunches** the ended session (a non-interactive agent stays down until its next open, and even Myra waits for the next `/v1/me` poll), and a disconnect that is never observed (the hub itself restarted, so it never saw the event) leaves the session `active` forever. The router has no `sidecar.connect` counterpart to `sidecar.disconnect`, so there is no reconnect event to hang the relaunch on.

`registerWedgeSweepReconciler({ db, router, sessionService, grantStore, eventCollectors, intervalMs, graceMs })` (`apps/hub/src/services/agent-provisioning.ts`, wired in `apps/hub/src/index.ts` after `createSessionService`) closes both gaps with a periodic `reconcileWedgedSessions` pass (default 30s, `WEDGE_SWEEP_INTERVAL_MS`). Each tick selects instances whose session is `active` and whose instance status is one of `WEDGE_RELAUNCHABLE_STATUSES` (`running`/`deployed`/`updating` — `error` is the leaked-agent state and `stopped` is an explicit teardown, both excluded), then acts only on those whose address is not in `getRoutableAddresses()`, ending the session via `reconcileDisconnectedSession` and relaunching via `relaunchInstanceIfNeeded`.

**It gates on _sustained_ unroutability, not session age.** `agent_session.updatedAt` is never bumped while a session stays `active` (every writer transitions it to `ended`; the orchestrator's `agent.reconnected` handler touches `agentInstance.updatedAt`, not the session), so it equals `createdAt` for a live agent's entire life and carries no signal about reconnect progress — a session-age floor would fire on a routine redeploy reconnect and _evict the reconnecting agent_. Instead the reconciler owns an in-process `Map<address, firstSeenUnroutableAt>`: each tick, a routable address drops its entry; a newly-unroutable one is recorded and **skipped** (never acted on at first sighting); and only an address that stays continuously unroutable for `graceMs` (`DEFAULT_UNROUTABLE_GRACE_MS`, 120s, `WEDGE_UNROUTABLE_GRACE_MS`) is ended-and-relaunched, after which its entry is consumed. The grace exceeds both the 90s disconnect grace and typical sidecar reconnect-settle time, so a healthy redeploy reconnect clears the tracker before the sweep ever acts; the hub-restart case still works because the map rebuilds from empty. Entries for addresses that drop out of the candidate set are pruned so the map cannot grow unbounded.

It composes with the disconnect reconciler without double-launching — both re-read `getRoutableAddresses()` right before acting (so a reconnect landing between selection and relaunch is a no-op), and every relaunch funnels through the process-local dedup/cooldown breaker (`runDedupedRelaunch`), which coalesces a concurrent `/me` relaunch of the same instance. A reentrancy flag skips a tick while the previous sweep is still in flight, so a slow pass never overlaps the next interval. Same single-hub-replica caveat as the disconnect reconciler: the routability read is this hub's local router state. The registration returns an unsubscribe that clears the (unref'd) interval; `apps/hub/src/index.ts` captures it and calls it in the SIGTERM/SIGINT drain.

## Environment Configuration

All environment validation lives in `apps/hub/src/config.ts`. Variables are validated at startup via `requireEnv()` — no silent defaults for required values.

`loadConfig()` sets a module-level singleton; `getConfig()` returns it. Library modules that need config values import `getConfig()` directly — they do not reach into `process.env` themselves. This keeps validation in one place and makes config access testable via `mock.module('../config', ...)`.

### Added Variables

| Variable                     | Required | Purpose                                                                                                                                                                                                        |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GLOBAL_TENANT_SLUG`         | Yes      | Slug of the root tenant (the deployment's org, `config.rootTenant`), seeded at hub boot. Deployment-specific, never hardcoded. Env key retains the `GLOBAL_` prefix for wire-compatibility.                    |
| `GLOBAL_TENANT_NAME`         | Yes      | Display name of the root tenant (e.g. the org's name for this deployment).                                                                                                                                     |
| `GLOBAL_TENANT_DOMAIN`       | Yes      | Domain of the root tenant; Myra instance addresses are `instanceId@<domain>`.                                                                                                                                  |
| `WEDGE_SWEEP_INTERVAL_MS`    | No       | Cadence (ms) of the wedge-sweep reconciler that relaunches active-but-unroutable instances after a sidecar restart. Positive integer; defaults to 30000.                                                       |
| `WEDGE_UNROUTABLE_GRACE_MS`  | No       | How long (ms) an address must stay continuously unroutable before the wedge sweep relaunches it. Must exceed the 90s disconnect grace and sidecar reconnect-settle time. Positive integer; defaults to 120000. |
| `SCHEDULER_ENABLED`          | No       | Emergency env override forcing the automation scheduler on regardless of the owner feature grant (the grant on Owner → Capabilities is the primary switch). Default off.                                       |
| `HEARTBEAT_HOUR_UTC`         | No       | UTC hour the seeded per-Myra heartbeat schedule fires at. Defaults to 13.                                                                                                                                      |
| `TRIAGE_ENABLED`             | No       | Emergency env override forcing ephemeral Myra triage on regardless of the owner feature grant. Default off.                                                                                                    |
| `TASKS_RECONCILER_ENABLED`   | No       | Emergency env override forcing the task-push reconciler on regardless of the owner feature grant. Default off.                                                                                                 |
| `FEATURE_GRANT_CACHE_TTL_MS` | No       | TTL for the in-process feature-grant check cache. Defaults to 30s.                                                                                                                                             |

### Client deployment

Each client runs as an **isolated Railway stack** (hub + sidecar + web + Postgres + volumes) — same code image, made a distinct org by its environment. Base config for a client is a committed, **non-secret** manifest at `clients/<slug>.toml`: tenant identity (`GLOBAL_TENANT_*`), public URLs, and branding, one block per Railway environment (`production`, `staging`). `scripts/provision-client.ts` reads the manifest (`Bun.TOML.parse`, validated with arktype in `scripts/provision-client/plan.ts`), generates the secrets (`BETTER_AUTH_SECRET`, `HUB_SIGNING_KEYS`, the shared hub↔sidecar `SIDECAR_TOKEN`), resolves the auth/CORS/websocket wiring graph from the manifest URLs, and sets every per-service variable on the target Railway environment (`railway variables --set`), creating the environment if needed and preserving already-present secrets on re-run. Build/deploy config is **not** managed by the script — it stays in the committed `apps/*/railway.toml` (Railway Config-as-Code). Secrets live only in Railway; credentials live only in the Owner UI. Full runbook: [`CLIENT_STANDUP.md`](./CLIENT_STANDUP.md).

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
cp .env.example .env
# Edit required values
```

Per-instance env files are also provided for running services independently:

- `.env.hub.example` → `.env.hub` — hub-specific variables
- `.env.sidecar.example` → `.env.sidecar` — sidecar-specific variables
- `.env.migrate.example` → `.env.migrate` — migration-only variables

To seed providers and credentials locally, copy your API keys into the appropriate env file, then run the admin CLI (`bun run admin`), select the tenant, and choose **Local actions → Seed tool credentials from env**.

This reads `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GEMINI_API_KEY` (or `GEMINI_API_KEY`), `GRANOLA_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `BROWSERBASE_API_KEY` (+ `BROWSERBASE_PROJECT_ID`), `XAI_API_KEY`, `SCRAPECREATORS_API_KEY`, `GAMMA_API_KEY`, `GITHUB_API_KEY`, and `YOUTUBE_API_KEY` and upserts the corresponding providers and tenant credentials. For Google Gemini it creates provider `google-genai`, reconciles `metadata.baseURL` on existing tenant-owned provider rows, and upserts credential **`google-ai`** (overridable via `GOOGLE_AI_CREDENTIAL_NAME`) with `metadata.model` from `GOOGLE_AI_MODEL` (default `gemini-3.1-flash-lite`). That model env var is stored on the credential only; SEO enrich uses the workflow `defaultModel`, not the env var. The `buildEntries()` function is the single list of seeded providers; each entry is skipped silently when its key is unset.

`add-llm-credential.ts` also upserts `google-ai` when a Gemini key is set, but does not patch stale provider metadata on existing `google-genai` rows — use `seed-credentials.ts` when upgrading SEO enrich or fixing a misconfigured provider base URL.

Production seeding requires `HUB_URL`, `GLOBAL_TENANT_SLUG`, and either `SESSION_TOKEN` (OAuth-only) or `SUPERADMIN_EMAIL` / `SUPERADMIN_PASS`. See [`DEPLOY.md`](../DEPLOY.md) Step 5.

**Adding a credentialed tool:** when a new `@workbench/tools-*` package declares a credential `providerName`, you must add a matching entry to `buildEntries()` in `apps/hub/bin/seed-credentials.ts` (reading a `*_API_KEY` env var) and list that env var in `.env.example`, or the tool will resolve no credential in deployed environments and return nothing. Keyless tools (e.g. the public Bluesky AppView) need no entry.

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

## File Parsing (CL-2628)

Model-agnostic document understanding for agents whose adapter cannot read documents (see ARCHITECTURE.md § File Parsing).

- **File Parser definition** — `packages/agents/src/file-parser/`. An `AGENT_TEMPLATES` entry (`deployable: false`) bound to `anthropic` / `claude-sonnet-5`, reusing the tenant's existing `anthropic-api` inference credential (the same one Fannie/Freddie use — no new seed/env).
- **Parse turn** — `apps/hub/src/services/file-parser.ts` `parseDocument()`. Resolves the File Parser definition across the tenant ancestor chain, resolves its inference source (`resolveInstanceSourcesFromDefinition`), and runs one non-streaming `@intx/agent` turn, sending the bytes as a `MessageAttachment`. The anthropic adapter marshals them into a native `document` block (`interchange/packages/inference/src/turns.ts` → `providers/anthropic.ts`). The turn is recorded under the caller's session for cost attribution.
- **`parse_file` tool** — `@workbench/tools-fileparser` (hub-backed, keyless) + `apps/hub/src/lib/file-parser-tools.ts`. Reads a file artifact, decodes its data URL, and calls `parseDocument`. Granted to Myra; the on-demand path over an existing artifact.
- **Upload route** — `POST /api/v1/instances/:instanceId/parse-file` (`apps/hub/src/routes/file-parse.ts`). Auth'd against the instance tenant via `getRequestedUserContext`, size-capped, stores the doc as a `kind: "file"` artifact, parses it, and returns `{ artifactId, filename, parsedText }`. The user-upload path.
- **Client diversion** — `apps/web/src/hooks/use-myra-session.ts` routes **every** attachment (images and documents alike) through the parse route for an agent whose model is not natively vision-capable; nothing rides inline. Parsed text is folded into a leading `<context>` block, which `packages/agents/src/adapter.ts` `stripContextBlock` hides from the rendered bubble while delivering the full text to Myra; a chip renders from optimistic client state. This is why Myra can accept a screenshot even though `kimi-k2.6` is text-only: the Claude-backed File Parser does the OCR and hands back text (uploads and clipboard pastes are the same `PendingAttachment` → `send` path, so both divert identically).
- **Gate** — `packages/agents/src/attachment-capabilities.ts`. A parser-equipped agent's composer policy unions document MIME types — **plus image MIME types when the agent's own model is not natively vision-capable** (`IMAGE_MIME_TYPES` from `@workbench/catalog`) — onto its native accepted set. `kimi-` was removed from `VISION_MODEL_PREFIXES` (its openai-compatible endpoint 400s on `image_url` parts), so Myra's native capability is now `none` and images flow only via the parser. The hub inline-mail guard (`apps/hub/src/attachment-capability-guard.ts`) is unchanged and stays native, so neither a document nor an image can ride inline to a model that cannot consume it.
- **Inbound-mail divert (CL-3575)** — the composer diversion above only covers attachments a member sends Myra through the chat UI; an EXTERNAL inbound email delivered straight to Myra Triage (`apps/hub/src/services/mailbox-triage.ts`) never passes through the composer, so an image/document attachment on that mail would otherwise ride inline as a `MessageAttachment` and 400 a text-only triage model (e.g. `deepseek-v4-flash` on the openai-compatible adapter) at inference time. `mailbox-triage.ts`'s `buildTriageMessage()` extracts attachments off the raw MIME frame via `extractAttachments` (`@intx/mime`), and `runOne()` — the triage dequeue path, the point where the recipient's agent definition is already resolved — hands them to `divertInboundAttachments()` (`apps/hub/src/lib/mailbox-attachment-divert.ts`). That helper narrows against the triage agent definition's own native accepted MIME types (`acceptedMimeTypesForAgentRow`, factored out of `attachment-capability-guard.ts` so the composer guard and this server-side divert share one classifier); a native-incapable attachment is stored as a `kind: "file"` artifact and run through `parseDocument`, and its extracted text is folded into the turn content as a leading `<context>` block instead of an inline attachment. A vision-capable triage definition (e.g. anthropic-backed) is left alone — every attachment still rides inline. A parse failure for one attachment degrades to a logged note in its own context block rather than dropping the whole triage turn.

**v1 storage/latency stopgaps (fast-follow):** uploaded file bytes are stored base64 in `artifact.content` (a text column), and the upload route parses **synchronously in-request** and **eagerly on every upload**. This is intentional for v1 simplicity; the durable direction is binary/object storage with a lifecycle, moving the parse off the request thread (background job + notify), and revisiting eager-vs-lazy once those land.

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
   import type { InferenceSource } from "@intx/types/runtime";

   const source: InferenceSource = {
     id: `my-task-${id}`,
     provider: "openai",
     baseURL:
       process.env.OPENAI_COMPATIBLE_BASE_URL || "https://api.openai.com/v1",
     apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
     model: process.env.OPENAI_COMPATIBLE_MODEL || "gpt-4o-mini",
   };
   ```

2. Create a temporary agent with an ephemeral context directory:

   ```typescript
   import { createAgent } from "@intx/agent";
   import { tmpdir } from "node:os";
   import { join } from "node:path";
   import { randomUUID } from "node:crypto";

   const contextDir = join(tmpdir(), `task-${randomUUID()}`);
   const agent = await createAgent({
     contextDir,
     sources: [source],
     defaultSource: source.id,
     systemPrompt: "Your system instructions...",
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

### Generic run view (`WorkflowRunBlocks`)

Located in `apps/web/src/components/WorkflowRunBlocks.tsx`. The generic run-page fallback used by `WorkflowRunPane` when a workflow ships no bespoke `Panel`. It renders the run as **UIBlocks** — the same block substrate the chat dock renders — so the standalone Workflows page and the dock stay consistent. It replaced the former raw `RunConsole`, which dumped a step's `outputRef` as a raw `Output: inline:{…}` string.

**Behavior:**

- Builds blocks via `buildDockBlocks(kind, …)` (`apps/web/src/lib/dock-block-builders.ts`) over the folded `RunState` + decoded step outputs — a migrated kind supplies its own builder, every other kind falls through to the generic `dockRunBlocks` synthesis (`packages/blocks/src/run-dock-blocks.ts`). Renders them with `UIBlockView`.
- Shows a progress timeline (phase per step) and a typed gate `choice` block for any `awaiting-signal` step; selecting it resumes via `WorkflowRunPane`'s `onBlockRespond` → `resolveResumePayload` → the run's `/resume` (the same contract the dock uses).
- Renders a legible terminal-failure affordance (interrupted vs failed copy + "Start a new run") for a failed run, since the block substrate alone leaves an interrupted run — one with no per-step error — blank.

### Command Palette

A global Cmd/Ctrl+K command palette for keyboard-first navigation (see PRODUCT.md § Command Palette). Navigation commands are client-side; entity results come from a server-side aggregate search (CL-2500).

- **Shared contract** — `packages/workbench-shared/src/palette.ts` exports the `PaletteResultItemSchema` arktype schema (category union `navigation | conversation | agent | workflow | artifact | skill | tool`, `PaletteResultItem` derived via `typeof Schema.infer`), the `PaletteSearchResponseSchema` (`{ results, page, hasMore }`), and a dependency-free subsequence fuzzy matcher (`fuzzyMatch`/`rankPaletteItems`) used for client-side nav ranking and entity-title highlighting. Both hub and web validate against this one schema. A tiny ranked-substring matcher was chosen over Fuse.js/uFuzzy to avoid a runtime dependency.
- **Server search** — `GET /api/tenants/:tenantId/search?q=&page=` (`apps/hub/src/routes/search.ts` → `apps/hub/src/services/search.ts`, mounted on `hubApp` behind Interchange's `resolveTenant`). `searchTenant` aggregates six sources — chats (`member_agent_instance`, myra), workflows (distinct `workflow_run.kind`), agents (`agent_instance ⋈ agent`, excluding member-owned instances), artifacts (`artifact`), skills (`asset` where `kind='skill'`), and tools (the in-process `listAvailableToolSummaries` catalog). **Every DB source carries a `tenant_id = ?` predicate** (`tenant.id` from `resolveTenant`), so cross-tenant rows cannot appear. Each source returns at most 5 rows at `OFFSET page*5` (a `+1` fetch sets `hasMore`); relevance is a SQL `CASE` rank (exact > prefix > contains) tie-broken by recency, mirrored in-process for tools via `scoreText`. Rows are normalized to `PaletteResultItem` and validated through `PaletteResultItemSchema` before return.
- **Provider** — `apps/web/src/components/command-palette-context.tsx` (`CommandPaletteProvider`, wired into `AppShell` in `apps/web/src/router.tsx`) owns open/closed state, the global Cmd/Ctrl+K listener (a capture-phase `keydown` subscription — the one legitimate effect), and a 200 ms-debounced query. Entity results are fetched with TanStack `useInfiniteQuery` (`searchPaletteEntities` in `apps/web/src/lib/palette-search.ts`, `keepPreviousData`, `AbortController` via `signal`, gated on `open` + active tenant + non-empty query; a new query is a fresh key so pagination resets). `fetchNextPage` drives "Load more". Static **Go to** commands (`NAV_COMMANDS`, beside the route table in `router.tsx`) stay client-side. Navigates via react-router `useNavigate` on selection.
- **Component** — `apps/web/src/components/CommandPalette.tsx` is controlled (query lifted to the provider). It fuzzy-ranks nav commands client-side and renders the already-matched server entity rows in server order (highlight-only). It renders a centered overlay (backdrop `rgba(0,0,0,0.55)` + `backdrop-blur`, `rounded-panel` surface); the input is `role="combobox"`, results are `role="listbox"`/`role="option"` — **not** a dialog — with `aria-activedescendant` tracking the active row. Arrow Up/Down `preventDefault()` first (so the caret never moves) and are ignored, with Enter, during an IME composition. The panel uses an **opacity-only** transition with `initial={false}`; `PALETTE_PANEL_MOTION` is exported and asserted transform-free by a brand regression test. Loading/empty/error states are explicit.
- **Entity routing** — conversations → `/chats/:threadId`, artifacts → `/artifacts/:artifactId`, skills → `/skills/:assetId`, tools → `/tools/:name`. Workflows have no per-deployment route (→ `/workflows`); agents have no detail route (→ `/chats`).
- **Testing** — `searchTenant` is integration-tested against a drizzle `pg-proxy` recording driver that generates **real SQL**, asserting the `tenant_id` predicate + bound tenant param on every source (cross-tenant isolation), the relevance `CASE` ordering, and `LIMIT 6` / `OFFSET page*5`. No live Postgres is required and none is available in the test harness.
- **Deferred (v2)** — content / full-text search (`pg_trgm` similarity or a Postgres FTS `tsvector` index) and a global cross-source relevance merge. v1 is plain `ILIKE` ordering with no new pg extension or migration.

### Page Transitions

**Panel animations** (within a page):

- Left panels animate in from left: `x: -40, opacity: 0` → `x: 0, opacity: 1`
- Right panels animate in from right: `x: 40, opacity: 0` → `x: 0, opacity: 1`
- Spring transition: `type: 'spring', stiffness: 300, damping: 30`
- Staggered delays: left panel 0.1s, right panel 0.15s
