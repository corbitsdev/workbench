# Creating Agents, Tools, and Workflows

This guide explains how to build and wire new capabilities in GTM Workbench. It covers the three primitives — tools, agents, and workflows — and how they compose to make capabilities dynamically available across the platform.

## Conceptual Model

**Tools** are self-contained packages that perform a discrete external action (search, scrape, fetch, write). They live in `packages/tools-<name>/` and are pinned per agent (and, for native workflows, per workflow step) as tarballs the sidecar materializes in-process.

**Agents** are definitions that run on Interchange's sidecar. An agent declares what credentials it needs, and which tools it can call. The tools an agent sees are controlled by its `capabilities.tools` list — nothing else. An agent with an empty list cannot call any tools, regardless of what the hub has registered.

**Workflows** are native `@intx/workflow` pipelines deployed to the hub. Each step declares its own inference and tools in the definition; credentials resolve from the tenant at deploy time. They run on Interchange's native runtime — the hub does not orchestrate steps. See [DEPLOYING_WORKFLOWS.md](./DEPLOYING_WORKFLOWS.md) and the "Creating a Workflow" section below.

A tool is a native Interchange tool **package** (a tarball). An agent pins the
packages it needs; the sidecar materializes them in-process at launch. There is
no agent-side tool proxy. Workflows run on Interchange's native runtime and use
their own tool packages too — the hub runs no workflow tools server-side.

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
> `apps/hub/src/lib/tool-registry.ts` still exists, but **only as the tool→provider
> mapping for the credential rail** (`run-credential-tool`, `tool-credentials`); it
> is no longer in any agent's or workflow's execution path. Workflows now run on
> Interchange's native runtime, so the former hub workflow tool registry is gone.

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
- Agents need no `KNOWN_TOOLS` entry. `KNOWN_TOOLS` now only carries the
  tool→provider mapping for the credential rail (`run-credential-tool`); it is not
  an execution registry.

### 4. Build and push

Per environment, copy `.env.tools.example` to `.env.staging` / `.env.production`
(both gitignored), fill in `HUB_URL` + admin creds + `HUB_TENANT_SLUG`, then:

Run the admin CLI (`bun run admin` / `admin:staging` / `admin:production`), sign
in, select the target tenant, then run **Local actions → Build tool packages**
followed by **Publish tool packages**. The selected tenant is threaded
automatically.

The build action packs the tarballs (`dist/tool-packages/`); the publish action
find-or-creates
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
> to get a session. Wiring publish into the deploy pipeline is intentionally
> deferred — for now it's a deliberate manual step per environment.

**Deploy ordering.** Publish MUST run for the target tenant before any
agent that pins a new package/version launches there — otherwise the closure
resolver finds no tarball and the launch **fails loudly** (the sidecar loader is
fail-hard now: a manifest it can't load fails the launch rather than silently
dropping tools). Wire publish into the deploy step so a deploy cannot
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
**gone**. `KNOWN_TOOLS` remains only as the tool→provider mapping for the
credential rail — not an execution registry, and not in any workflow path
(workflows run on Interchange's native runtime).

---

## Creating an Agent Package

Copy an existing agent as a starting point. Agents live as subdirectories of the
`@workbench/agents` package (`packages/agents/src/<name>`) — `packages/agents/src/larry`
is a good minimal example of an agent that uses tools.

### 1. Scaffold

```bash
cp -r packages/agents/src/larry packages/agents/src/<name>
```

Rename the exported identifiers and strip the copied agent's prompt/tools down to
your own; `seedAgentTemplates` picks the definition up on the next hub boot.

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

Workflows are **native `@intx/workflow` definitions**, not hub code. Each kind is its own package under `workflows/<kind>/` named `@workbench/workflow-<kind>`, exporting `kind` and `workflow`. The hub imports no workflow code — adding a workflow needs no hub change. Full guide: [DEPLOYING_WORKFLOWS.md](./DEPLOYING_WORKFLOWS.md).

### 1. Define the workflow

```ts
// workflows/my-workflow/src/index.ts
import { defineWorkflow, defineAgent, step, awaitSignal } from '@intx/workflow';

export const kind = 'my-workflow';

export const workflow = defineWorkflow({
  id: 'my-workflow',
  trigger: { type: 'manual' },
  steps: {
    intake: step({ agent: defineAgent({ id: 'intake' /* prompt, tools, inference */ }) }),
    generate: step({ agent: defineAgent({ id: 'generate' /* … */ }), after: ['intake'] }),
    approval: awaitSignal({ name: 'artifact-approval', after: ['generate'] }), // HITL gate
  },
});
```

Per-step inference and tools are declared on each `defineAgent`. `awaitSignal` steps are the human-in-the-loop gates a user approves in the run console.

### 2. Push it

Run the admin CLI (`bun run admin` / `admin:staging` / `admin:production`), sign
in, select the tenant, then **Local actions → Push a workflow** and type the kind
value at the "Workflow kind" prompt (e.g. `my-workflow`).

This serializes the definition and POSTs it to `POST /api/internal/workflows/deploy` (service-token auth). The hub commits it to a git-backed `workflow` repo and the sidecar workflow-host supervisor drives the run. No catalog registration, no hub step handlers.

---

## Making Tools Dynamically Available

Tools are pinned as packages on each agent (and on each native workflow step). No per-tool changes are needed on the agent or workflow side beyond the pin.

**To add a tool to an existing agent**: update `capabilities.tools` in the agent definition and re-provision the agent instance. The hub builds `HarnessConfig.tools` from this list at launch time.

**To add a tool to a workflow step**: pin the tool package on the step's `defineAgent` in the workflow definition (`workflows/<kind>/`) and re-push the workflow.

**To give an ad-hoc agent access to a tool**: set `capabilities.tools` to include the tool name when provisioning the agent via `POST /v1/agents`. No other code change is required.

This is the key property: the tool package and the agent's `toolPackages` pin are the only things that need to change. The sidecar, the credential system, and the inference layer are all tool-agnostic.

---

---

## Recurring / Scheduled Agent Work

> **Removed.** The per-instance agent scheduler (`@workbench/agent-scheduler`, `startInstanceScheduler`, `getSchedulerIntervalMs`, and the `schedulerIntervalMs` capability) has been deleted. There is no longer a host loop that sends a periodic `"sync"` message to an agent session.

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
- [ ] Credentialed tools only: present in `KNOWN_TOOLS` for the credential rail's tool→provider mapping (not an execution registry)
- [ ] Built + published to the registry (admin CLI **Local actions → Build / Publish tool packages**); tool verified loading in the sidecar
- [ ] Unit tests at ≥95% function coverage

## Checklist: Shipping a New Agent

- [ ] `packages/agents/src/<name>/` created from an existing agent (e.g. `larry`), builds cleanly
- [ ] `credentialRequirements` declared for inference + any external services
- [ ] `capabilities.tools` lists every tool the agent is allowed to call
- [ ] System prompt written via `buildSystemPrompt` + `formatFromModel`
- [ ] Director filters inbound senders
- [ ] Provisioning wired in `tenant-provisioning.ts`
- [ ] Credential provider entries exist for every requirement
