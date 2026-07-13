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
export function createMyTools(config: {
  apiKey: string;
  baseURL: string;
}): AgentTool[] {
  return [
    {
      kind: "string",
      definition: MY_DEFINITION,
      handler: async (args) => "...",
    },
  ];
}
```

Tools never read `process.env`; credentials/baseURL come from the caller.

**Tools never read their store directory at runtime either.** The sidecar's
`loadToolPackages` memoizes `loadManifest` results per manifest hash across
agent instance launches (`apps/sidecar/src/agent-tools.ts`); a factory
closure that resolves paths relative to its own module location
(`__dirname`, `import.meta.url`/`import.meta.dir`) and reads the filesystem
at call time can outlive the per-instance store directory it was imported
from, silently reading a different instance's files or a directory that no
longer exists. Read any file the tool needs from paths passed in via the
factory's `env`/args, not from the module's own location. This is enforced
by a static scan over every `packages/tools-*/src` file in
`packages/tools-interchange-contract/src/no-runtime-store-reads.test.ts`.

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
import { createToolRunner, defineTool } from "@intx/agent";
import { createMyTools } from "./tools";

export const myTools = defineTool({
  id: "@workbench/tools-<name>/<name>",
  factory: () => createToolRunner(createMyTools()),
});
```

**Credentialed** tools use the credential rail — declare the provider and read
the key from env (delivered separately from inference sources, never via
`credentialRequirements`):

```ts
import { defineCredentialedToolPackage } from "@workbench/tool-credentials";
import { MY_HUB_TOOLS } from "./index";

export const myTools = defineCredentialedToolPackage({
  id: "@workbench/tools-<name>/<name>",
  provider: "my-provider", // tenant credential provider name
  entries: MY_HUB_TOOLS, // entries' createTools({ apiKey, baseURL }) are reused
});
```

### 3. Export a tool manifest, pin on agents, configure credentials in Owner UI

- Add `src/tool-manifest.ts` exporting `toolManifestFile` (`ToolManifestFile`; see any
  `packages/tools-*/src/tool-manifest.ts`) and wire `package.json` →
  `interchange.manifest` to that file.
- Run `bun run build:tool-manifests` (hub) to refresh
  `apps/hub/generated/tool-manifests/index.json`. `TOOL_PACKAGES`,
  `PACKAGE_TOOLS`, `PACKAGE_PROVIDERS`, the Myra catalog, and the tool subset of
  `CREDENTIAL_PROVIDER_CATALOG` are **derived** from committed manifests — do not
  hand-edit those lists. Dockerfile `COPY` lines for tool packages are guarded by
  `packages/tool-manifest/src/dockerfile-tool-copy.test.ts` (update Dockerfiles
  when adding a package).
- Pin it on each agent that uses it via `toolPackages: [{ name, version }]` on
  the agent's `AGENT_TEMPLATES` entry. `seedAgentTemplates` persists the pins to
  the agent DB row on hub boot; `launchAgentSession` reads them back via
  `parseAgentRow(row).toolPackages` at launch time.
- Credentialed tools: set `providerName` and optional `credentialCatalog` on the
  factory manifest (and `CREDENTIAL_PROVIDER_CATALOG` overrides in
  `packages/workbench-shared/src/credential-provider-catalog.ts` when the owner
  form needs extra fields). Owners
  configure secrets on the Capabilities page — not via env seeding.
- `KNOWN_TOOLS` is a drift guard only: every bare tool name from manifests must
  appear there for the credential rail (`run-credential-tool`); it is not an
  execution registry.

### 3b. Register a friendly chat phrase (CL-3268)

Chat never surfaces wire tool ids (`attio__create_record`, snake_case bare names).
Every tool the user can see in Myra (or any chat host that wires
`friendlyToolSummary`) needs a hand-authored progressive phrase in
`packages/agents/src/friendly-tool-summary.ts` → `PHRASES`.

```ts
// packages/agents/src/friendly-tool-summary.ts
const PHRASES: Record<string, Phrase> = {
  // bare operation key (after package prefix stripping)
  my_tool_do_thing: (args) => {
    const target = firstStringArg(args, ["name", "query"]);
    return target === null
      ? "Doing the thing"
      : `Doing the thing for ${truncate(target)}`;
  },
  // or a static string when no useful arg exists
  my_tool_list: "Listing my things",
};
```

Rules:

- **Key = bare operation key**, not the LLM form. `attio__create_record` and
  `attio_create_record` both resolve to `attio_create_record`. For tools whose
  bare name has no package prefix (`search_skills`), key the bare name.
- **Phrase = progressive action English** the user can read mid-flight:
  `"Creating an Attio record for Acme"`, never `"Attio Create Record"` or the
  wire id. Prefer brand names (`Attio`, `Linear`) over generic labels (`CRM`).
- **Interpolate a high-signal arg** when one exists (`name`, `query`, `url`,
  issue id). Fall back to a static phrase when args are empty — do not invent
  values.
- **Myra catalog tools** also pick up this phrase as the `search_tools`
  description (via `MYRA_TOOL_CATALOG`). Adding a package to
  `MYRA_CATALOG_PACKAGES` without a `PHRASES` entry fails the
  `CL-3268 catalog phrase coverage` test in
  `friendly-tool-summary.test.ts`.
- Unknown tools still soft-fall back to a present-participle frame
  (`"Working on mystery do thing"`) so the UI never shows snake_case or a Title
  Case tool id — but that is a safety net, not a substitute for a hand-authored
  phrase on a known tool.
- **Platform meta-tools** (`search_tools`, `load_tools`) are not user-facing
  capabilities. Flag them with `isCatalogMetaTool` so chat hosts render quiet
  reasoning-style lines (no checkmark / tool chrome), exclude them from roll-up
  counts, and keep the activity pill generic (`Myra is thinking`). Wire
  `isQuietTool={isCatalogMetaTool}` on Myra chat surfaces.

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
- **Hub-backed tools** (`artifact_*`, `write_artifact`, `vercel_deploy_artifact`,
  `list_agents`, `list_principals`, `dispatch_agent`) are also tarballs — built with
  `defineHubBackedToolPackage`. Their definitions live in the package; each call
  forwards over the `workbench.hubRpc` rail to the scoped
  `POST /api/internal/hub-tools/run`, which executes hub-side and authorizes
  against the instance principal's grants. No tool secrets in the sidecar.
- **Approval-gated publish tools** (`vercel_deploy_static_file`,
  `vercel_deploy_artifact`) require human approval in the sidecar harness before
  the deploy runs.

The agent-session proxy (`createHubToolRunner` → `/api/internal/tools/run`) is
**gone**. `KNOWN_TOOLS` remains only as the tool→provider mapping for the
credential rail — not an execution registry, and not in any workflow path
(workflows run on Interchange's native runtime).

---

## Creating an Agent Package

Copy an existing agent as a starting point. Agents live as subdirectories of the
`@workbench/agents` package (`packages/agents/src/<name>`) — copy a small existing
agent that matches the tool/inference shape you need.

### 1. Scaffold

```bash
cp -r packages/agents/src/walter packages/agents/src/<name>
```

Rename the exported identifiers and strip the copied agent's prompt/tools down to
your own; `seedAgentTemplates` picks the definition up on the next hub boot.

### 2. Write the system prompt (`src/prompt.ts`)

```ts
import { buildSystemPrompt, formatFromModel } from "@workbench/agents";

export function buildMyAgentPrompt(model: string): string {
  return buildSystemPrompt(
    [
      { title: "Role", content: "You are..." },
      { title: "Pipeline", content: "Follow these steps in order: ..." },
      {
        title: "Output discipline",
        content: "Never produce structured data in chat...",
      },
    ],
    formatFromModel(model),
  );
}
```

`formatFromModel` returns `'xml'` for Claude models and `'markdown'` for all others. Use it — it makes prompts structurally correct for the model receiving them.

### 3. Define the agent (`src/definition.ts`)

```ts
import type { AgentDefinition } from "@intx/types";

export const myAgentDefinition: AgentDefinition = {
  name: "My Agent",
  credentialRequirements: [
    // Inference — required for every agent
    {
      providerName: "openai-compatible",
      source: "tenant",
      name: "My Agent LLM",
    },
    // External services — declare each one the agent needs
    { providerName: "exa", source: "tenant" },
  ],
  capabilities: {
    // List every tool name this agent is allowed to call.
    // Tools not in this list are invisible to the agent at runtime.
    tools: ["exa_search", "my_tool"],
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
import { createDefaultDirector } from "@intx/agent";
import type { DirectorFactory } from "@intx/types";

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

## Rolling out agent changes (how an edit reaches existing users)

Editing a template in `@workbench/agents` (prompt, `toolPackages` pins, capabilities, model) does **not** reach running agents by itself. Two facts drive the rollout:

- **Definitions are shared, not per-user.** Every user's Myra instance points at a _single_ `agent` row in the global tenant (one row per template). Instances are thin pointers — they store status/principal, not the prompt/pins. So one upsert updates everyone.
- **The shared row is (re)written by `seedAgentTemplates(db)`, which runs on every hub boot** (`apps/hub/src/index.ts`, right after `seedGlobalTenant`). It is an idempotent upsert over `AGENT_TEMPLATES`. **This is the only thing that writes template changes to the DB** — `seedGlobalTenant` returns early when the tenant already exists and does not touch agent rows. (Before this call existed, every template edit was silently ignored on already-seeded environments — agents stayed frozen at the first manual seed.)
- **Instances adopt the new definition on their next launch.** `launchSession` reads `agentRow.toolPackages` + `systemPrompt` fresh each time. Running sessions are auto-relaunched when the hub reboots on deploy; stopped/idle instances relaunch on the user's next app load. No per-instance migration or backfill is needed.
- **Tool grants are reconciled on boot, not just at launch.** A member's instance principal carries `tool:<name>/invoke` grant rows synthesized at launch. Because `provisionMemberInstances` skips members who already have an instance, a _newly added_ tool (e.g. Granola on Myra) would otherwise never reach existing members until each relaunched — surfacing as `No matching grants for tool:…/invoke` at invoke time. To close this, `reconcileMemberInstanceGrants` (`apps/hub/src/services/grant-reconcile.ts`) runs right after `seedAgentTemplates` on every boot: it rewrites every member instance's tool + requirement grants to the freshly-seeded definition. It is DB-only at boot (sidecars push the updated grants when they reconnect after the hub starts) and idempotent. To fix members **without** a redeploy, an operator can `POST /admin/templates/:templateKey/reconcile-grants` (admin CLI → `Agents` → "Reconcile member instance grants for a template"), which also pushes fresh grants to any live sidecar with no restart.

### Production rollout order

Do the tenant-side seeding **before** deploying the hub, so that when instances relaunch with new pins the packages actually resolve (otherwise launches partially load — the package that isn't published is silently dropped):

1. **Build + Publish tool packages to the prod GLOBAL tenant** (`admin:production` → Build, then Publish → global org) — required whenever a pinned package is added or bumped.
2. **Seed the prod global tenant**: LLM credential, model catalog, and tool credentials (`admin:production`). See [ADMIN_CLI.md](./ADMIN_CLI.md).
3. **Deploy the hub.** Boot runs `seedAgentTemplates` → the shared rows update → relaunches inherit the new definition.
4. **(Optional) Force an immediate refresh:** restart the **sidecar** service so all running sessions relaunch at once. This is the safe hammer — no history loss.

### Do NOT

- **Mass-delete instances** (`cleanup-instances`) to "force an update" — instances are pointers and re-provision automatically, and bulk deletion churns the sidecar volume (corrupt-pack / `ENOENT` storage errors). Use a sidecar restart instead if you need an instant refresh.
- Assume a code push alone updates agents — it only updates the DB once the **hub boots** the new code (and the registry/catalog/credentials are in place).

---

## Creating a Workflow

Workflows are **native `@intx/workflow` definitions**, not hub code. Each kind is its own package under `workflows/<kind>/` named `@workbench/workflow-<kind>`, exporting `kind` and `workflow`. The hub imports no workflow code — adding a workflow needs no hub change. Full guide: [DEPLOYING_WORKFLOWS.md](./DEPLOYING_WORKFLOWS.md).

### 1. Define the workflow

```ts
// workflows/my-workflow/src/index.ts
import { defineWorkflow, defineAgent, step, awaitSignal } from "@intx/workflow";

export const kind = "my-workflow";

export const workflow = defineWorkflow({
  id: "my-workflow",
  trigger: { type: "manual" },
  steps: {
    intake: step({
      agent: defineAgent({ id: "intake" /* prompt, tools, inference */ }),
    }),
    generate: step({
      agent: defineAgent({ id: "generate" /* … */ }),
      after: ["intake"],
    }),
    approval: awaitSignal({ name: "artifact-approval", after: ["generate"] }), // HITL gate
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

### Dynamic tool exposure (advertise on demand, CL-2808)

Pinning controls what an agent _has_; dynamic exposure controls what the model _sees_. An agent that opts in advertises only a small **platform** tool set on turn one (`PERSONAL_AGENT_PLATFORM_TOOLS` — `search_tools`/`load_tools`, memory, the core artifact surface, workflow entry points, skill discovery); everything else its pinned packages ship stays loaded and dispatchable but hidden until the model asks for it. Grants and the catalog are **derived** from one source (`MYRA_CATALOG_PACKAGES` in `catalog.ts`): a package's tools are never hand-listed twice, so the catalog, grants, and pins cannot drift (CL-3190). The grant list `PERSONAL_AGENT_BASE_TOOLS` is exactly `platform ∪ catalog`.

- `search_tools({ query, package?, tags? })` — deterministic keyword search over `MYRA_TOOL_CATALOG` in `packages/agents/src/dynamic-tools/catalog.ts`. Per-package search metadata (summary + tags) is hand-authored; the tool names in each entry are **derived** from the package's real tools (`bareToolNamesForPin`) minus the platform set.
- `load_tools({ names?, package? })` — adds tools (individually or a whole package) to the session's sticky exposure set; they appear in the model's function list on the next inference call of the same turn.

Mechanics: the harness (`apps/sidecar/src/default-harness.ts`) builds one mutable `ToolExposureState`, hands it to the catalog runner (`createCatalogTools` in `@workbench/tools-catalog`) and to the `@workbench/agents/dynamic-tools` director via `env[DYNAMIC_TOOLS_ENV_KEY]`. The director wraps `createDefaultDirector` and rewrites each `infer` to advertise `base ∪ catalog-tools ∪ exposed`. Only advertisement changes — `allowedNames`, grants, and credentials are untouched, so a hidden tool called after `load_tools` executes through the normal rails.

The catalog runner and env catalog are built _after_ the tool factories run, and the static catalog is intersected against the tools that actually loaded (`filterCatalogByAvailableTools`). A catalog package whose tenant credential is missing is dropped fail-soft at construction, so it never appears in `search_tools` results — otherwise the model is pointed at a package it can never call and loops on the search (CL-3133).

`search_tools` also carries a loop guard (state lives in the `createCatalogTools` closure): a run of _consecutive identical_ searches with no intervening `load_tools` escalates its hint and then hard-errors past a threshold. It counts only consecutive, load-free runs — a different query or a `load_tools` call resets the run — so a genuinely progressing session (Myra's persist across days) never accumulates toward a stop; only a stuck run trips it. This is advisory — the director cannot force the model — but it stops a non-converging model from spinning on an identical search payload forever. Distinct queries and returned matches are never withheld.

Opt-in is via `resolveDynamicToolConfig(systemPrompt)` (prompt-marker match, like `resolveMailOutboundLimit`); only Myra opts in today. `@workbench/tools-catalog` is a **local in-process runner, not a tarball tool package** — it needs direct access to the exposure state, so it is not registered in the package build, not published to the registry, and not pinned in `toolPackages`. It is keyless (no seed-credentials entry).

When a catalog-managed package gains or loses a tool, update its entry in `PACKAGE_TOOLS` (`packages/agents/src/tool-names.ts`) — the catalog, grants, and pins all derive from it, so a tool missing from `PACKAGE_TOOLS` is loaded by the sidecar but neither cataloged nor granted: it is advertised on turn one (falls into the base set) yet denied at invoke. To give Myra a new integration, add its package to `MYRA_CATALOG_PACKAGES`; to keep a capability workflow-only (Gamma, last30days), leave its package out entirely.

---

## Recurring / Scheduled Agent Work

> **Removed.** The per-instance agent scheduler (`@workbench/agent-scheduler`, `startInstanceScheduler`, `getSchedulerIntervalMs`, and the `schedulerIntervalMs` capability) has been deleted. There is no longer a host loop that sends a periodic `"sync"` message to an agent session.

All agents are now uniform: interactive and recover-on-open. They respond to inbound mail and are brought back when needed (Myra auto-relaunches via `POST /v1/me`; other agents recover on the next open). No agent runs on a host-driven timer.

Recurring work is moving to **workflows**, which will provide native scheduling. Do not reintroduce a per-agent timer in the hub — model recurring work as a workflow when that capability lands.

A director may still allow a system sender address (e.g. `scheduler@system`) for messages that arrive over normal mail infrastructure; that is unrelated to the removed host scheduler.

---

## Checklist: Shipping a New Tool

- [ ] `packages/tools-<name>/` builds cleanly; `package.json` has `version` + `interchange.tools` + `interchange.manifest`
- [ ] `src/tool-manifest.ts` describes tools, providers, and Myra catalog metadata
- [ ] `src/interchange-tools.ts` exports a `defineTool` factory (keyless) or `defineCredentialedToolPackage` (credentialed)
- [ ] No `process.env` reads; no LLM calls
- [ ] `bun run build:tool-manifests` run; Dockerfile tool `COPY` lines updated if the drift test fails
- [ ] Pinned via `toolPackages` on each using agent's descriptor **and** `AGENT_TEMPLATES` entry
- [ ] Credentialed: `providerName` / `credentialCatalog` in manifest + owner catalog (`packages/workbench-shared/src/credential-provider-catalog.ts` overrides if needed) + agent `credentialProviderNames`
- [ ] Credentialed tools only: bare tool names from manifest appear in `KNOWN_TOOLS` (drift guard for the credential rail)
- [ ] Built + published to the registry (admin CLI **Local actions → Build / Publish tool packages**); tool verified loading in the sidecar
- [ ] Unit tests at ≥95% function coverage

## Checklist: Shipping a New Agent

- [ ] `packages/agents/src/<name>/` created from an existing agent, builds cleanly
- [ ] `credentialRequirements` declared for inference + any external services
- [ ] `capabilities.tools` lists every tool the agent is allowed to call
- [ ] System prompt written via `buildSystemPrompt` + `formatFromModel`
- [ ] Director filters inbound senders
- [ ] Provisioning wired in `tenant-provisioning.ts`
- [ ] Credential provider entries exist for every requirement
- [ ] Rollout understood — a template edit only reaches users after the hub boots (`seedAgentTemplates`) and instances relaunch; seed the global tenant + publish tool packages **before** deploy. See [Rolling out agent changes](#rolling-out-agent-changes-how-an-edit-reaches-existing-users).
