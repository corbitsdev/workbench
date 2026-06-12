# Creating Agents, Tools, and Workflows

This guide explains how to build and wire new capabilities in GTM Workbench. It covers the three primitives — tools, agents, and workflows — and how they compose to make capabilities dynamically available across the platform.

## Conceptual Model

**Tools** are self-contained packages that perform a discrete external action (search, scrape, fetch, write). They live in `packages/tools-<name>/` and are registered with the hub. Any tool in the hub's registry can be assigned to any agent or workflow step.

**Agents** are definitions that run on Interchange's sidecar. An agent declares what credentials it needs, and which tools it can call. The tools an agent sees are controlled by its `capabilities.tools` list — nothing else. An agent with an empty list cannot call any tools, regardless of what the hub has registered.

**Workflows** are step-by-step pipelines. Each step declares its own credentials and tools independently. At workflow install time, the user assigns a specific credential and tool set to each step. This is how the same workflow can use different credentials per step (e.g. Granola for intake, OpenAI for generation).

The hub's tool registry is the source of truth. Every tool that exists in the registry is available for assignment to any agent or workflow step — no code changes required on the agent or workflow side.

```
packages/tools-<name>/   →   hub KNOWN_TOOLS registry   →   agent capabilities.tools
                                                          →   workflow step tools
```

---

## Creating a Tool Package

Use `packages/tool-template` as a starting point. Copy the directory, rename it, and fill in the stubs.

### 1. Scaffold

```bash
cp -r packages/tool-template packages/tools-<name>
```

Update `package.json`:

```json
{
  "name": "@workbench/tools-<name>",
  "version": "0.0.1",
  "private": true,
  "exports": { ".": "./src/index.ts" }
}
```

Add to `tsconfig.json` references and `bun` workspaces as with other packages.

### 2. Implement `src/index.ts`

Every tool package exports exactly two things:

```ts
import type { AgentTool, ToolEntry } from '@intx/types';

// Tool definition — this is what the model sees (name, description, parameters schema)
const myToolDefinition = {
  name: 'my_tool',
  description: 'What this tool does, written for the model.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
    },
    required: ['query'],
  },
};

// Factory — returns AgentTool handlers; config is supplied by the hub at call time
export function createMyTools(config: { apiKey: string }): AgentTool[] {
  return [
    {
      definition: myToolDefinition,
      async run({ query }) {
        // Call the external API using config.apiKey — never process.env
        const result = await fetch('https://api.example.com/search', {
          headers: { Authorization: `Bearer ${config.apiKey}` },
          // ...
        });
        return { result: await result.text(), isError: false };
      },
    },
  ];
}

// Hub registry entry — tells the hub which credential to resolve and how to invoke the factory
export const MY_HUB_TOOLS: Record<string, ToolEntry> = {
  my_tool: {
    providerName: 'my-provider', // matches the credential provider name in Interchange
    definition: myToolDefinition,
    createTools: (config) => createMyTools(config),
  },
};
```

**Rules:**

- Tools never read `process.env`. Config (API key, base URL) is always supplied by the caller.
- Tools are data-only. They fetch from external APIs and return raw results. No LLM calls inside a tool.
- Return `{ result: string, isError: boolean }`. On error, set `isError: true` and put the message in `result`.

### 3. Register with the hub

In `apps/hub/src/lib/tool-registry.ts`, spread your registry entry into `KNOWN_TOOLS`:

```ts
import { MY_HUB_TOOLS } from '@workbench/tools-<name>';

export const KNOWN_TOOLS = {
  ...EXA_HUB_TOOLS,
  ...GRANOLA_HUB_TOOLS,
  ...MY_HUB_TOOLS, // add this line
};
```

That's it. The sidecar's `HubToolRunner` is generic — it proxies all tool calls to `POST /api/internal/tools/run` without knowing anything about specific tools. No sidecar changes are ever needed when adding a tool.

### 4. Register the credential provider (if new)

If your tool requires a credential that doesn't already exist in the hub, add it as a provider via `ensureProvider` in the credential creation flow, and add the provider name to the Settings UI's provider list so tenants can save credentials for it.

The credential's `providerName` must match the `providerName` field in your `*_HUB_TOOLS` entry — this is how the hub resolves the right credential at call time.

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

This is the key property: the tool package, the hub registry, and the agent/workflow capability list are the only three things that need to change. The sidecar, the credential system, and the inference layer are all tool-agnostic.

---

---

## Recurring / Scheduled Agent Work

> **Removed in CL-1696.** The per-instance agent scheduler (`@workbench/agent-scheduler`, `startInstanceScheduler`, `getSchedulerIntervalMs`, and the `schedulerIntervalMs` capability) has been deleted. There is no longer a host loop that sends a periodic `"sync"` message to an agent session.

All agents are now uniform: interactive and recover-on-open. They respond to inbound mail and are brought back when needed (Myra auto-relaunches via `GET /v1/me`; other agents recover on the next open). No agent runs on a host-driven timer.

Recurring work is moving to **workflows**, which will provide native scheduling. Do not reintroduce a per-agent timer in the hub — model recurring work as a workflow when that capability lands.

A director may still allow a system sender address (e.g. `scheduler@system`) for messages that arrive over normal mail infrastructure; that is unrelated to the removed host scheduler.

---

## Checklist: Shipping a New Tool

- [ ] `packages/tools-<name>/` created from `tool-template`, builds cleanly
- [ ] Exports `create<Name>Tools(config)` and `*_HUB_TOOLS`
- [ ] No `process.env` reads; no LLM calls
- [ ] Spread into `KNOWN_TOOLS` in `apps/hub/src/lib/tool-registry.ts`
- [ ] Credential provider registered if new
- [ ] Added to at least one agent's `capabilities.tools` or one workflow step's `tools`
- [ ] Unit tests at ≥95% function coverage

## Checklist: Shipping a New Agent

- [ ] `packages/agents/<name>/` created from `tool-agent`, builds cleanly
- [ ] `credentialRequirements` declared for inference + any external services
- [ ] `capabilities.tools` lists every tool the agent is allowed to call
- [ ] System prompt written via `buildSystemPrompt` + `formatFromModel`
- [ ] Director filters inbound senders
- [ ] Provisioning wired in `tenant-provisioning.ts`
- [ ] Credential provider entries exist for every requirement

