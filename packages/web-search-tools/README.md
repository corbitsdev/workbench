# @corbits/web-search-tools

A minimal web-search integration: one client call, one `@intx/agent` tool
bundle. Built for the last-30-days-research workflow port (CL-5997);
backed by Exa, the same provider the OG gtm-workbench's
`last30days-research` workflow called for this source
(`packages/tools-exa`) — a real, honest backend rather than a placeholder.

## Tools

- `web_search` — searches the web for a query, returning up to 25 results
  (default 5) as `{ url, title, publishedAt (ISO 8601), source: "web",
author? }`. When a result has no real publish date, `publishedAt` falls
  back to fetch time and `provenance: "degraded"` is set, so it stays in
  a date window but ranks below dated results instead of being dropped.

## Credential

The bundle's env requires `webSearchApiKey` (an Exa API key). When it is
absent or empty, the tool never throws — it returns a completed result
with `isError: true` and content naming the source "not connected", so a
calling agent can degrade gracefully instead of failing its turn.

## Usage

```ts
import { webSearchTools } from "@corbits/web-search-tools";

const agent = defineAgent({
  // ...
  tools: [webSearchTools],
});
```
