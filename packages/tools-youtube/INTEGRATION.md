# tools-youtube Integration Notes

Changes required outside `packages/tools-youtube/` to wire this package into the workbench.

## 1. Hub tool registry

Register `YOUTUBE_HUB_TOOLS` in `apps/hub/src/tools/registry.ts` (or wherever
`HACKERNEWS_HUB_TOOLS` and `SCRAPECREATORS_HUB_TOOLS` are registered):

```ts
import { YOUTUBE_HUB_TOOLS } from '@workbench/tools-youtube';

// Merge into the existing hub tools map
export const HUB_TOOLS = {
  ...HACKERNEWS_HUB_TOOLS,
  ...SCRAPECREATORS_HUB_TOOLS,
  ...YOUTUBE_HUB_TOOLS,
};
```

`YOUTUBE_HUB_TOOLS` exports one entry:

```ts
youtube_search: {
  definition: YOUTUBE_SEARCH_DEFINITION,  // ToolDefinition
  providerName: 'youtube',                // credential provider name (see §3)
  createTools: (config: YouTubeToolsConfig) => AgentTool[]
}
```

The hub registry must resolve the `youtube` credential and pass `{ apiKey, fetcher? }` to `createTools`.

## 2. Larry's credentialProviderNames

In `packages/agents` (Larry's deploy descriptor), add `'youtube'` to `credentialProviderNames`:

```ts
credentialProviderNames: [
  // existing providers...
  'youtube',
],
```

This causes the settings UI to prompt for a YouTube Data API v3 key when onboarding Larry.

## 3. Credential provider registration

Add a `youtube` credential provider to the hub's credential provider registry (wherever
`scrapecreators`, `firecrawl`, etc. are declared):

```ts
{
  name: 'youtube',
  displayName: 'YouTube Data API',
  fields: [{ name: 'apiKey', label: 'API Key', secret: true }],
}
```

The API key is a standard Google Cloud API key scoped to YouTube Data API v3.

## 4. Dockerfile COPY lines

Add to every Dockerfile image that depends on hub or sidecar (hub image, sidecar image):

### Manifest-copy section (before `bun install`):

```dockerfile
COPY packages/tools-youtube/package.json packages/tools-youtube/
```

### Source-copy section (after `bun install`):

```dockerfile
COPY packages/tools-youtube/ packages/tools-youtube/
```

## 5. workspace package.json / bun workspaces

`packages/tools-youtube` must appear as a workspace member. In the root `package.json`
`workspaces` array, add:

```json
"packages/tools-youtube"
```

(Check whether the root already uses a glob like `"packages/*"` — if so, no change needed.)

## 6. topComments omission

`ResearchItem` has no `topComments` field. YouTube's `commentThreads.list` endpoint could
provide comment text, but there is nowhere to store it in the current schema. The field is
omitted. If `ResearchItem` is extended with `topComments` in the future, a second API call
to `commentThreads.list?part=snippet&videoId=<id>&maxResults=3` would supply the data.
