# @corbits/capability-tools

The `request_capability` `@intx/agent` tool bundle (CL-6084): an agent's
in-chat way to ask for a tool package, skill, or model it doesn't have
yet. Declared `approval: "ask"` — Interchange's native per-invocation
gate suspends the call as a pending approval and renders it in chat
before this bundle's own code ever runs; a human has to allow it before
the addition happens.

## The tool

- `request_capability({ kind, name, why, title? })` — `kind` is
  `"tool-package" | "skill" | "model"`, `name` is the capability's exact
  name as offered by the workspace's live inventory (never invented),
  `why` is a one-sentence reason shown on the approval card, and
  `title` is an optional short human label (e.g. `"GitHub tools"`) that
  makes the approval card read naturally.

On approval, the execution calls the workflow-run capabilities surface
for the calling agent's own definition. Success comes back as a plain
result message ("Added @corbits/github-tools — I can use it from my
next reply."); an out-of-inventory request comes back naming what's
actually available, never a fabricated success. Any other transport or
HTTP failure comes back as an honest `isError: true` result.

## Activated end-to-end (CL-6086)

Both gaps this package was originally written against are now closed:

1. **Definition-id context.** `env.definitionId` is threaded from
   `apps/sidecar/src/workflow-substrate-factory/step-env.ts`, following
   exactly the binding pattern `@corbits/memory-tools`' `hubMemoryUrl`/
   `sidecarToken`/`address` use — the run's own definition id, resolved
   at the substrate factory from `WORKFLOW_DEFINITION_REPO_ID`.
2. **Workflow-run-authenticated capabilities route.**
   `@corbits/agent-directory`'s `createWorkflowCapabilityRoutes`
   (`packages/agent-directory/src/workflow-capability-routes.ts`) mounts
   at `/api/workflow-capabilities` in `apps/hub`, beside
   `/api/workflow-skills`. It authenticates via the same
   `createWorkflowRunAuthenticator` (sidecar bearer token + run
   address), and constrains a call to the caller's OWN definitionId
   (403 on any other target).

   That route deliberately does NOT gate on a grant-store check for the
   own-definition case — Interchange's grant materialization still
   never seeds a `kind: "workflow"` run's principal an `update` grant on
   its own definition ([Intx gap], tracked durably by CL-6085). Instead
   the route relies on the approval that already happened: this
   bundle's `request_capability` tool is declared `approval: "ask"`, so
   the reactor suspends every call as a pending approval and renders it
   in-chat BEFORE this bundle's `run` — and therefore before the route
   is ever called — executes. The human who approved the card is the
   authorizer; the route's own unconditional checks (own-definition-only,
   fail-closed inventory) are what it enforces beyond that. See the
   route's own file-level comment for the full reasoning.

`@corbits/capability-tools` is pinned into every drafted agent's default
tool-package set whenever the tenant's inventory offers it
(`packages/agent-directory/src/agent-definition-drafting.ts`), and listed
in `apps/hub`'s `listMyraUsableToolPackages`.

## Usage

```ts
import { capabilityTools } from "@corbits/capability-tools";

const agent = defineAgent({
  // ...
  tools: [capabilityTools],
});
```

## Running tests

```sh
cd packages/capability-tools && bun test
```

Tests run against a mocked fetch/`WorkflowCapabilityEnv`; no `DATABASE_URL`
or live hub is required.
