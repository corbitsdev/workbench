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

## Two open gaps (CL-6084)

This package is written against the shape both gaps below imply, so
wiring it up is a drop-in once they close — neither is fixed by this
package, and both are outside its file set:

1. **No definition-id context.** A tool execution has no sanctioned way
   to learn its own agent definition id (`ToolCall`, `BaseEnv`, and the
   workflow runtime's per-step invoke request all lack one). It needs to
   be threaded into `env.definitionId` the same way
   `apps/sidecar/src/workflow-substrate-factory/step-env.ts` threads
   `@corbits/memory-tools`' `hubMemoryUrl`/`sidecarToken`/`address` in
   today — `apps/sidecar` is not in this change's file set.
2. **No workflow-run-authenticated capabilities route.**
   `@corbits/agent-directory`'s `POST /:definitionId/capabilities` and
   `GET /capabilities/inventory` are mounted only under the tenant-
   session-authenticated prefix. Reaching them from a workflow-process
   child needs a `createWorkflowCapabilityRoutes` factory (mirroring
   `packages/skills/src/workflow-routes.ts`), mounted in `apps/hub`
   beside `/api/workflow-skills` — plus a run's own `kind: "workflow"`
   principal actually being granted `update` on its own definition
   somewhere in Interchange's grant materialization, which doesn't
   happen today either. Neither is in this change's file set.

## Usage

```ts
import { capabilityTools } from "@corbits/capability-tools";

const agent = defineAgent({
  // ...
  tools: [capabilityTools],
});
```
