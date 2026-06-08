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

## Creating a Continuously Running Agent (Cron / Loop)

Some agents need to run on a recurring schedule rather than only responding to user messages — Oat is the canonical example. Oat checks for new Granola call recordings every 60 seconds and processes them into artifacts, regardless of whether a user has sent a message.

This is implemented via the **instance scheduler** (`@workbench/agent-scheduler`). The mechanism is simple: the scheduler sends the string `"sync"` to the agent's session on each interval tick, as if it were a message from `scheduler@system`. The agent's prompt and director handle this trigger the same way they handle any other inbound message.

### 1. Declare the interval in capabilities

Add `schedulerIntervalMs` to the agent definition's capabilities:

```ts
export const myAgentCapabilities = {
  tools: ['my_tool'],
  schedulerIntervalMs: 60_000, // milliseconds; omit for non-scheduled agents
} as const;
```

The hub reads this value via `getSchedulerIntervalMs(capabilities)` at launch time. If the field is present, `startInstanceScheduler` is called automatically when the session launches. No other hub wiring is needed.

### 2. Accept the scheduler sender in the director

The scheduler sends from the address `scheduler@system`. Your director must include this in the allowed senders list, or the sync message will be rejected:

```ts
export function createMyAgentDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[]
): ReactorDirector {
  const base = createDefaultDirector(systemPrompt, toolDefinitions);
  const allowedSenders = ['scheduler@system'];

  return {
    async decide(event, state, capabilities) {
      if (event.type === 'message.received') {
        const sender = event.message.headers.from;
        if (!allowedSenders.includes(sender)) {
          return [capabilities.reply('Not authorised'), capabilities.wait()];
        }
      }
      return base.decide(event, state, capabilities);
    },
  };
}
```

You can add other allowed senders (e.g. a specific Myra instance address) to the same list.

### 3. Handle the sync trigger in the system prompt

The agent receives the literal string `"sync"` as the message content on each tick. Your system prompt should tell the agent what to do when it receives this:

```
When you receive a "sync" message, check for new [X] and process any that have
not been handled yet. Do not reply with commentary — complete the work and wait.
If there is nothing new, do nothing.
```

The scheduler skips a tick if the agent is already mid-inference, so there is no risk of overlapping runs.

### 4. How the scheduler lifecycle works

- The scheduler starts automatically after `startInstanceScheduler` is called from the hub at session launch.
- It stops automatically when the agent's reactor emits `reactor.done` (i.e. the session ends).
- The hub calls `startInstanceScheduler` on session launch, session reconnect, and relaunch. All three paths are covered — the scheduler restarts with the session.
- The cleanup function returned by `startInstanceScheduler` is called on hub shutdown.

### What Oat does as a reference

- `schedulerIntervalMs: 60_000` — checks every 60 seconds
- Director allows `scheduler@system` as a sender
- On `"sync"`: calls `granola_list_notes`, compares against already-processed call IDs, calls `granola_get_note` for new ones, creates call document artifacts
- On other messages (e.g. from Myra): responds normally

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

## Checklist: Shipping a Scheduled Agent (Cron / Loop)

All items from the agent checklist above, plus:

- [ ] `schedulerIntervalMs` set in capabilities (in milliseconds)
- [ ] Director allows `scheduler@system` as a sender
- [ ] System prompt documents what to do on a `"sync"` message
- [ ] System prompt instructs the agent not to reply with commentary on sync ticks
- [ ] Tested that the agent processes new items and skips correctly when there is nothing to do
