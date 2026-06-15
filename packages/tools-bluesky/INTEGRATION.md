# Integration Checklist

## Tool registration

- Tool name: `bluesky_search`
- ToolDefinition export: `import { BLUESKY_SEARCH_DEFINITION } from '@workbench/tools-bluesky'`
- Factory export: `import { createBlueskyTools, BLUESKY_HUB_TOOLS } from '@workbench/tools-bluesky'`

Add `BLUESKY_HUB_TOOLS.bluesky_search` to the hub tool registry (the same registry pattern used by `HACKERNEWS_HUB_TOOLS`).

## Credential provider

No credential provider is required for public/unauthenticated use. If authenticated access is needed, resolve `BLUESKY_IDENTIFIER` and `BLUESKY_APP_PASSWORD` from environment variables in the hub tool handler and pass them as `BlueskyToolsConfig.identifier` / `BlueskyToolsConfig.appPassword`. Do NOT add a bluesky provider to the agent's `credentialRequirements`.

Add to Larry's `credentialProviderNames` only if you choose to store the app password as a tenant credential.

## Dockerfile COPY lines

Add the following lines to `apps/hub/Dockerfile` and `apps/sidecar/Dockerfile` in the manifest-copy section (before `bun install`) and in the full-copy section:

```dockerfile
# manifest copy (before bun install)
COPY packages/tools-bluesky/package.json packages/tools-bluesky/

# full copy (after bun install)
COPY packages/tools-bluesky/ packages/tools-bluesky/
```

## Schema change

`'bluesky'` has already been added to the `SourceLabel` union in `packages/last30days-core/src/schema.ts` as part of CL-1992. No further schema changes are needed.
