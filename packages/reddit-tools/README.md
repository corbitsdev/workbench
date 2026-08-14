# @corbits/reddit-tools

A minimal Reddit search integration: one client, one `@intx/agent` tool
bundle. Built for the reddit-opportunity-scanner workflow (CL-5994) but
not specific to it — any agent that needs to search Reddit pins this
package.

## Why ScrapeCreators, not Reddit's own API

Matching the OG `gtm-workbench`'s `tools-reddit` package: Reddit's public
JSON endpoints get IP-blocked from datacenter hosts, and its
authenticated API needs an OAuth flow this platform does not run
server-side. This client proxies through
[ScrapeCreators](https://scrapecreators.com) instead — a plain `GET`
with an `x-api-key` header, no SDK. There is no separate Reddit
credential: it reuses the same ScrapeCreators API key any other
ScrapeCreators-backed integration in this workspace would use.

## Tools

- `reddit_search` — searches Reddit across all subreddits for a query.
- `reddit_subreddit_search` — searches one named subreddit for a query.

Both return posts as `{ title, url, permalink, subreddit, createdAt,
upvotes, numComments }`, newest-first as ScrapeCreators returns them.
There is no "fetch one thread" tool — the OG's `tools-reddit` package
only ever exposed the two search endpoints above, so this port keeps
the same minimal surface.

## Credential

The bundle's env requires `scrapeCreatorsApiKey`. When it is absent or
empty, the tool never throws — it returns a completed result with
`isError: true` and content naming the source "not connected", so a
calling agent can degrade gracefully instead of failing its turn.

## Usage

```ts
import { redditTools } from "@corbits/reddit-tools";

const agent = defineAgent({
  // ...
  tools: [redditTools],
});
```
