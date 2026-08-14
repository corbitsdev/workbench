# @corbits/github-tools

A minimal GitHub search integration: one client call, one `@intx/agent`
tool bundle. Built for the last-30-days-research workflow port (CL-5997),
mirroring the OG gtm-workbench's `packages/tools-github` client against
GitHub's real public REST search API.

## Tools

- `github_activity` — searches GitHub for recently active repositories,
  issues, and pull requests matching a topic within a days window,
  returning a normalized list: `{ url, title, publishedAt (ISO 8601),
source: "github", engagement, entityTag? }`. Repos carry `engagement:
{ stars }` and an `entityTag` (the full repo name); issues/PRs carry
  `engagement: { upvotes, comments }` (reactions mapped to upvotes).

## Credential

Unlike this port's other source (`@corbits/web-search-tools`), GitHub's
search endpoints work with **no credential at all** — an absent
`githubApiKey` just means the request goes out unauthenticated, at
GitHub's lower rate limit (60 requests/hour vs 5000/hour with a token).
The tool never returns a "not connected" result for a missing key; only a
failed HTTP call (rate-limited, network error) degrades to
`isError: true`, so a calling agent can read that as "GitHub is
unavailable right now" and say so honestly.

## Usage

```ts
import { githubTools } from "@corbits/github-tools";

const agent = defineAgent({
  // ...
  tools: [githubTools],
});
```
