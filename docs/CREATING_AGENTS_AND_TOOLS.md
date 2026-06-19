# Creating Agents, Tools, and Workflows

This guide explains how to build and wire new capabilities in GTM Workbench. It covers the three primitives — tools, agents, and workflows — and how they compose to make capabilities dynamically available across the platform.

## Conceptual Model

**Tools** are self-contained packages that perform a discrete external action (search, scrape, fetch, write). They live in `packages/tools-<name>/` and are registered with the hub. Any tool in the hub's registry can be assigned to any agent or workflow step.

**Agents** are definitions that run on Interchange's sidecar. An agent declares what credentials it needs, and which tools it can call. The tools an agent sees are controlled by its `capabilities.tools` list — nothing else. An agent with an empty list cannot call any tools, regardless of what the hub has registered.

**Workflows** are step-by-step pipelines. Each step declares its own credentials and tools independently. At workflow install time, the user assigns a specific credential and tool set to each step. This is how the same workflow can use different credentials per step (e.g. Granola for intake, OpenAI for generation).

A tool is a native Interchange tool **package** (a tarball). An agent pins the
packages it needs; the sidecar materializes them in-process at launch. There is
no agent-side tool proxy. (Workflow steps still resolve tools through the hub's
`KNOWN_TOOLS` registry server-side — a separate path that M4/M5 migrates.)

```
packages/tools-<name>/  →  workspace-builtins package-registry asset
                        →  agent toolPackages pin  →  sidecar loader (in-process)
```

---

## Creating a Tool Package

Tools are **native Interchange tool packages**: an `interchange.tools` entry
exporting `defineTool` factories, bundled into a self-contained tarball,
published to the `workspace-builtins` `package-registry` asset, pinned per
agent via `toolPackages`, and materialized **in-process by the sidecar
loader**. There is no hub round-trip at call time.

> **Status.** The agent-session tool proxy (`createHubToolRunner` →
> `POST /api/internal/tools/run`) has been **removed** — agents get every tool
> from pinned packages, with no hub round-trip at call time. `KNOWN_TOOLS` in
> `apps/hub/src/lib/tool-registry.ts` still exists, but **only as the workflow
> runtime's server-side tool registry** (`workflow-orchestration`,
> `run-credential-tool`); it is no longer in any agent's path. Migrating the
> workflow tool-execution path off `KNOWN_TOOLS` is workflow-runtime (M4/M5)
> scope.

### 1. Author the tool logic

Keep the tool implementation as before — a factory returning `AgentTool[]`:

```ts
export function createMyTools(config: { apiKey: string; baseURL: string }): AgentTool[] {
  return [{ kind: 'string', definition: MY_DEFINITION, handler: async (args) => '...' }];
}
```

Tools never read `process.env`; credentials/baseURL come from the caller.

### 2. Add the `interchange.tools` entry

In `package.json` add a `version` (required — the registry rejects versionless
tarballs) and the entry path:

```json
{
  "name": "@workbench/tools-<name>",
  "version": "0.1.0",
  "interchange": { "tools": "./dist/interchange-tools.js" }
}
```

Create `src/interchange-tools.ts`. **Keyless** tools:

```ts
import { createToolRunner, defineTool } from '@intx/agent';
import { createMyTools } from './tools';

export const myTools = defineTool({
  id: '@workbench/tools-<name>/<name>',
  factory: () => createToolRunner(createMyTools()),
});
```

**Credentialed** tools use the credential rail — declare the provider and read
the key from env (delivered separately from inference sources, never via
`credentialRequirements`):

```ts
import { defineCredentialedToolPackage } from '@workbench/tool-credentials';
import { MY_HUB_TOOLS } from './index';

export const myTools = defineCredentialedToolPackage({
  id: '@workbench/tools-<name>/<name>',
  provider: 'my-provider', // tenant credential provider name
  entries: MY_HUB_TOOLS, // entries' createTools({ apiKey, baseURL }) are reused
});
```

### 3. Register in the build, pin on agents, seed the credential

- Add the package to `TOOL_PACKAGES` in `apps/hub/bin/build-tool-packages.ts`
  and a `COPY` line in `apps/hub/Dockerfile`.
- Pin it on each agent that uses it via `toolPackages: [{ name, version }]` on
  the agent's `AGENT_TEMPLATES` entry. `seedAgentTemplates` persists the pins to
  the agent DB row on hub boot; `launchAgentSession` reads them back via
  `parseAgentRow(row).toolPackages` at launch time.
- Credentialed tools: seed the provider (`apps/hub/bin/seed-credentials.ts`)
  and add its `providerName` to the agent's `credentialProviderNames`. Keyless
  tools need no seed entry.
- Agents need no `KNOWN_TOOLS` entry. Only register a tool in `KNOWN_TOOLS` if a
  **workflow step** runs it server-side (that registry is workflow-only now).

### 4. Build and push

Per environment, copy `.env.tools.example` to `.env.staging` / `.env.production`
(both gitignored), fill in `HUB_URL` + admin creds + `HUB_TENANT_SLUG`, then:

```bash
bun run tools:push:staging      # build + publish using .env.staging
bun run tools:push:production   # build + publish using .env.production
```

`tools:build` packs the tarballs (`dist/tool-packages/`); `tools:publish` find-or-creates
the `workspace-builtins` `package-registry` asset and PUTs each one. Interchange's
`SessionService` then resolves each agent's pinned closure at launch, ships the
manifest, and the sidecar materializes it.

Two pieces are ours, both for concrete reasons:

- **Packer** (`build-tool-packages.ts`) — interchange's `bin/build-builtins.ts`
  hardcodes its `BUILTINS` to `@intx/tools-*` and isn't exported; the upstream
  comment directs downstreams to bring their own.
- **Publish client** (`publish-tool-packages.ts`) — interchange ships an
  equivalent `bin/publish-tool-packages.ts`, but it lives _inside_ the submodule,
  so invoking it resolves its own `@intx/*` imports from `interchange/`, which in
  a git-worktree layout can leak into a sibling worktree. Our client lives in
  `apps/hub/` and resolves cleanly. It still imports the **same** `@intx/types`
  schemas the hub's `GET /openapi.json` is generated from (`AssetResponse`, …), so
  it's aligned with the REST contract at its source — no `openapi-arktype`
  round-trip needed.

> **Deploy auth:** the client signs in with `HUB_ADMIN_EMAIL`/`HUB_ADMIN_PASSWORD`
> to get a session. Wiring `tools:push` into the deploy pipeline is intentionally
> deferred — for now it's a deliberate manual step per environment.

**Deploy ordering.** `tools:publish` MUST run for the target tenant before any
agent that pins a new package/version launches there — otherwise the closure
resolver finds no tarball and the launch **fails loudly** (the sidecar loader is
fail-hard now: a manifest it can't load fails the launch rather than silently
dropping tools). Wire `tools:push` into the deploy step so a deploy cannot
complete without it.

### Every tool is a tarball — including the hub-backed ones

All tool packages are **identical in shape**: an `interchange.tools` entry, a
tarball, a per-agent pin, loaded in-process. There is no agent-side tool proxy.

- **External tools** (firecrawl, exa, granola, reddit, x, scrapecreators,
  github, youtube, bluesky, gamma, hackernews, polymarket, last30days) run
  entirely in the sidecar; provider keys arrive via the credential rail.
- **Hub-backed tools** (`artifact_*`, `write_artifact`, `list_agents`,
  `list_principals`, `dispatch_agent`) are also tarballs — built with
  `defineHubBackedToolPackage`. Their definitions live in the package; each call
  forwards over the `workbench.hubRpc` rail to the scoped
  `POST /api/internal/hub-tools/run`, which executes hub-side and authorizes
  against the instance principal's grants. No tool secrets in the sidecar.

The agent-session proxy (`createHubToolRunner` → `/api/internal/tools/run`) is
**gone**. `KNOWN_TOOLS` remains only as the workflow runtime's server-side tool
registry — migrating that off `KNOWN_TOOLS` is M4/M5 scope.

---

## Creating an Agent Package

Use `packages/tool-agent` as a scaffold. It contains the minimal structure for an agent that uses tools.

### 1. Scaffold

```bash
cp -r packages/tool-agent packages/agents/<name>
```

Update `package.json` name to `@workbench/agent-<name>`.

### 2. Write the system prompt (`src/prompt.ts`)

```ts
import { buildSystemPrompt, formatFromModel } from '@workbench/agents';

export function buildMyAgentPrompt(model: string): string {
  return buildSystemPrompt(
    [
      { title: 'Role', content: 'You are...' },
      { title: 'Pipeline', content: 'Follow these steps in order: ...' },
      { title: 'Output discipline', content: 'Never produce structured data in chat...' },
    ],
    formatFromModel(model)
  );
}
```

`formatFromModel` returns `'xml'` for Claude models and `'markdown'` for all others. Use it — it makes prompts structurally correct for the model receiving them.

### 3. Define the agent (`src/definition.ts`)

```ts
import type { AgentDefinition } from '@intx/types';

export const myAgentDefinition: AgentDefinition = {
  name: 'My Agent',
  credentialRequirements: [
    // Inference — required for every agent
    { providerName: 'openai-compatible', source: 'tenant', name: 'My Agent LLM' },
    // External services — declare each one the agent needs
    { providerName: 'exa', source: 'tenant' },
  ],
  capabilities: {
    // List every tool name this agent is allowed to call.
    // Tools not in this list are invisible to the agent at runtime.
    tools: ['exa_search', 'my_tool'],
  },
  modelConfig: {
    temperature: 0.3,
  },
};
```

**Credential requirements** are resolved by Interchange at launch time. The agent never receives credential IDs — it just declares what it needs by provider name, and Interchange finds the right tenant credential.

**`capabilities.tools`** is the gating mechanism. An agent only sees tools explicitly listed here, regardless of what the hub has registered globally. This is how you give different agents different tool access without any per-agent code in the hub.

### 4. Write the director (`src/director.ts`)

Most agents need a custom director to filter inbound senders:

```ts
import { createDefaultDirector } from '@intx/agent';
import type { DirectorFactory } from '@intx/types';

export const createMyAgentDirector: DirectorFactory = (config) => {
  const base = createDefaultDirector(config);
  return {
    ...base,
    shouldProcess(message) {
      // Return false to drop messages from unexpected senders
      return message.from === config.instanceId || base.shouldProcess(message);
    },
  };
};
```

### 5. Wire provisioning

Add the agent to `apps/hub/src/lib/tenant-provisioning.ts`. This is where agents are created and associated with tenants on signup or on-demand. Follow the pattern of existing agents (Myra, Oat).

---

## Creating a Workflow

Workflows live in `@workbench/workflow-core`. Each workflow is a `WorkflowType` with a `steps[]` array.

### 1. Define the workflow

```ts
import type { WorkflowType } from '@workbench/workflow-core';

export const myWorkflow: WorkflowType = {
  kind: 'my-workflow',
  name: 'My Workflow',
  description: 'What this workflow does for the user.',
  steps: [
    {
      name: 'intake',
      label: 'Select sources',
      credentialRequirements: [{ providerName: 'granola' }],
      tools: ['granola_list_notes', 'granola_get_note'],
    },
    {
      name: 'generate',
      label: 'Generate output',
      credentialRequirements: [{ providerName: 'openai-compatible' }],
      tools: [], // inference only — no tool calls in this step
    },
  ],
};
```

Per-step `credentialRequirements` and `tools` are what the install UI collects from the user. At run time, each step gets only its assigned credential and tools — not the full set.

### 2. Register in the catalog

Add the workflow to the catalog export in `@workbench/workflow-core`. It will appear at `GET /workflows/catalog` and become available for tenants to add to their workbench.

### 3. Implement step handlers in the hub

Each step name maps to a handler in the hub's workflow router. Step handlers receive the step's resolved credential and assigned tool IDs. Follow the pattern of existing step handlers in `apps/hub/src/routes/workflow.ts`.

---

## Making Tools Dynamically Available

Once a tool is registered in `KNOWN_TOOLS`, it is available for assignment to any agent or workflow step. No per-tool changes are needed on the agent or workflow side.

**To add a tool to an existing agent**: update `capabilities.tools` in the agent definition and re-provision the agent instance. The hub builds `HarnessConfig.tools` from this list at launch time.

**To add a tool to a workflow step**: add the tool name to the step's `tools` list in the `WorkflowType` definition. Users will see it available for selection when they install or update the workflow.

**To give an ad-hoc agent access to a tool**: set `capabilities.tools` to include the tool name when provisioning the agent via `POST /v1/agents`. No other code change is required.

This is the key property: the tool package and the agent's `toolPackages` pin are the only things that need to change. The sidecar, the credential system, and the inference layer are all tool-agnostic.

---

---

## Recurring / Scheduled Agent Work

> **Removed in CL-1696.** The per-instance agent scheduler (`@workbench/agent-scheduler`, `startInstanceScheduler`, `getSchedulerIntervalMs`, and the `schedulerIntervalMs` capability) has been deleted. There is no longer a host loop that sends a periodic `"sync"` message to an agent session.

All agents are now uniform: interactive and recover-on-open. They respond to inbound mail and are brought back when needed (Myra auto-relaunches via `GET /v1/me`; other agents recover on the next open). No agent runs on a host-driven timer.

Recurring work is moving to **workflows**, which will provide native scheduling. Do not reintroduce a per-agent timer in the hub — model recurring work as a workflow when that capability lands.

A director may still allow a system sender address (e.g. `scheduler@system`) for messages that arrive over normal mail infrastructure; that is unrelated to the removed host scheduler.

---

## Checklist: Shipping a New Tool

- [ ] `packages/tools-<name>/` builds cleanly; `package.json` has `version` + `interchange.tools`
- [ ] `src/interchange-tools.ts` exports a `defineTool` factory (keyless) or `defineCredentialedToolPackage` (credentialed)
- [ ] No `process.env` reads; no LLM calls
- [ ] Added to `TOOL_PACKAGES` in `bin/build-tool-packages.ts` and a `COPY` line in `apps/hub/Dockerfile`
- [ ] Pinned via `toolPackages` on each using agent's descriptor **and** `AGENT_TEMPLATES` entry
- [ ] Credentialed: provider seeded in `seed-credentials.ts` + added to the agent's `credentialProviderNames`
- [ ] Only if a **workflow step** runs the tool: register it in `KNOWN_TOOLS` (workflow-only registry; agents need no entry)
- [ ] `bun run tools:push` publishes to the registry; tool verified loading in the sidecar
- [ ] Unit tests at ≥95% function coverage

## Checklist: Shipping a New Agent

- [ ] `packages/agents/<name>/` created from `tool-agent`, builds cleanly
- [ ] `credentialRequirements` declared for inference + any external services
- [ ] `capabilities.tools` lists every tool the agent is allowed to call
- [ ] System prompt written via `buildSystemPrompt` + `formatFromModel`
- [ ] Director filters inbound senders
- [ ] Provisioning wired in `tenant-provisioning.ts`
- [ ] Credential provider entries exist for every requirement
