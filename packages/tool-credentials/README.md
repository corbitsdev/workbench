# @workbench/tool-credentials

The credential rail for in-sidecar native tool packages, and the helper that
builds a credentialed package's `interchange.tools` factory.

## Writing a best-effort tool wrapper — use the shared helper, do not roll your own

A workflow step that must tolerate its tool failing (one of several sources,
an unconfigured integration) wraps that tool rather than flagging the step:
the native `action` primitive has no error-swallow, and the step harness
throws on any outer `ToolResult.isError`. The tolerated failure therefore
has to travel _inside_ `content`.

Both halves of that pattern already exist — build on them:

- `withToleranceEnvelope` / `runTolerantTool` / `invokeAgentTool` /
  `findAgentTool` in `./src/tolerance-envelope-dispatch.ts` (here, because
  dispatch needs `@intx/agent`)
- the envelope's shape — `ToleranceEnvelopeFailureSchema`,
  `isToleranceEnvelopeFailure`, `toleranceFailureContent`,
  `parseToleranceEnvelope` — in `@workbench/shared`'s `tolerance-envelope.ts`
  (there, because that package must stay free of Interchange internals, so
  any consumer can read the shape without pulling in the machinery)

Two rules the compiler will not enforce:

1. **Never set the outer `isError`.** A tolerated failure is a _successful_
   `ToolResult` whose `content` carries `{ isError: true, error }`. Setting
   the outer flag makes the harness throw and defeats the wrapper.
2. **Construct the credentialed inner package lazily, inside the handler.**
   `defineCredentialedToolPackage` throws when constructed without a
   credential, so building it at factory level means an unconfigured
   integration silently drops the whole wrapper and hard-fails the step —
   strictly worse than no wrapper at all. Cover it with a test that supplies
   no credential; a test that supplies one cannot catch this.

## Why

Tool-provider credentials must reach a tool **running in the sidecar** without
going through `credentialRequirements` (which is inference-only — a non-inference
provider there breaks sidecar launch with `Source provider "X" is not registered`).

## Contract

- A credentialed package's factory declares `requires: [toolCredentialEnvKey(p)]`
  and reads the key at construction via `getToolCredential(env, p)`.
- The sidecar collects those `workbench.cred.*` requirements off the loaded
  factories, fetches the resolved keys from the hub
  (`POST /api/internal/tools/credentials`, validated with `ToolCredentialsResponse`),
  and injects them into `env` before instantiating the factories.

## Entry points

- `@workbench/tool-credentials` — env-key helpers, `ToolCredential`, and the wire
  schemas (`ToolCredentialsRequest` / `ToolCredentialsResponse`). No `@intx/agent`
  dependency, so the hub and sidecar import it without loading the agent runtime.
  It also exports the live-deployments schemas (`LiveDeployment` /
  `LiveDeploymentsResponse`) shared by the hub's `GET /api/internal/deployments/live`
  route (producer) and the sidecar boot reconciler (consumer) — see CL-2231 and
  `docs/IMPLEMENTATION.md` § Sidecar deployment reclamation. These live here, with
  the other hub↔sidecar internal-rail schemas, so neither side pulls the agent
  runtime to parse them.
- `@workbench/tool-credentials/factory` — `defineCredentialedToolPackage`, which
  imports `@intx/agent`. Used only by tool packages.

## Usage in a credentialed tool package

```ts
// src/interchange-tools.ts
import { defineCredentialedToolPackage } from "@workbench/tool-credentials/factory";
import { MY_HUB_TOOLS } from "./index";

export const myTools = defineCredentialedToolPackage({
  id: "@workbench/tools-<name>/<name>",
  provider: "my-provider",
  entries: MY_HUB_TOOLS, // each entry's createTools({ apiKey, baseURL }) is reused
});
```

See `docs/CREATING_AGENTS_AND_TOOLS.md` for the full model.
