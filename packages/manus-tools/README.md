# @corbits/manus-tools

Manus OpenAPI v2 integration: a typed client and an `@intx/agent` tool
bundle covering tasks, files, skills, projects, agents, webhooks, usage,
connectors, browser, and website endpoints. Slide-deck creation is the
passing demo — `create_slides` starts a task, polls messages until the
agent stops, and surfaces output files (filename, url, id).

## Credential

The bundle's env carries `credentials`, the harness's consumer-gated
`CredentialCapability`. When it is absent, or `credentials.resolve("manus")`
throws, the tool never throws itself: it returns a completed result with
`isError: true` and content `"Manus is not connected for this user."`

This package declares one credential handle, `manus`, in
`package.json`'s `interchange.credentials`. Connect Manus once in Settings
· Connections (API key via `x-manus-api-key`). The client never attaches
that header — the `http-x-manus-api-key` credential plugin injects it.
The assistant workflow pins `@corbits/manus-tools` so the tools exist; it
does not require a Manus credential binding. An unconnected tenant
degrades at tool time to "Manus is not connected for this user." like
Granola, rather than failing launch.

## Usage

```ts
import { manusTools } from "@corbits/manus-tools";

const agent = defineAgent({
  // ...
  tools: [manusTools],
});
```

## Running tests

```
cd packages/manus-tools && bun test
```
