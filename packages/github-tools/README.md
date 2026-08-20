# @corbits/github-tools

A minimal GitHub integration: search, plus the pull-request reads and
one write a code review needs — two `@intx/agent` tool bundles. Built for the last-30-days-research workflow port (CL-5997),
mirroring the OG gtm-workbench's `packages/tools-github` client against
GitHub's real public REST search API.

## Tools

- `github_activity` — searches GitHub for recently active repositories,
  issues, and pull requests matching a topic within a days window,
  returning a normalized list: `{ url, title, publishedAt (ISO 8601),
source: "github", engagement, entityTag? }`. Repos carry `engagement:
{ stars }` and an `entityTag` (the full repo name); issues/PRs carry
  `engagement: { upvotes, comments }` (reactions mapped to upvotes).

- `github_pull_request_diff` — reads one pull request: title,
  description, head commit sha, and each changed file's patch, with
  `changedLines` naming the right-hand lines a review comment can be
  anchored to.
- `github_post_pull_request_review` — posts one comment-only review: a
  markdown body plus inline comments. Never approves, requests changes,
  or merges, which is why it is not approval-gated. GitHub rejects a
  comment anchored outside the diff, so anchor only to a line the diff
  reported.

## Credential

Unlike this port's other source (`@corbits/web-search-tools`), GitHub's
search endpoints work with **no credential at all** — an absent
`githubApiKey` just means the request goes out unauthenticated, at
GitHub's lower rate limit (60 requests/hour vs 5000/hour with a token).
The search tool never returns a "not connected" result for a missing
key; only a failed HTTP call (rate-limited, network error) degrades to
`isError: true`, so a calling agent can read that as "GitHub is
unavailable right now" and say so honestly.

The pull-request bundle is different: a private diff is not readable
keylessly and posting a review is a write, so an unbound `github` handle
comes back as a plain "not connected" result rather than a lower rate
limit.

## Usage

```ts
import { githubPullRequestTools, githubTools } from "@corbits/github-tools";

const agent = defineAgent({
  // ...
  tools: [githubTools, githubPullRequestTools],
});
```

## Running tests

```
cd packages/github-tools && bun test
```

No live database or real credentials required.
