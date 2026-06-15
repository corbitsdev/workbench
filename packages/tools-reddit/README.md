# @workbench/tools-reddit

Reddit research tools (`reddit_search`, `reddit_subreddit_search`) that return normalized
research items (title, thread URL, `publishedAt`, upvote/comment engagement, `r/<subreddit>`).

## Reddit is sourced via ScrapeCreators (provider != domain)

These tools hit ScrapeCreators' Reddit endpoints (`/v1/reddit/search`,
`/v1/reddit/subreddit/search`) with the `x-api-key` header, and their `providerName` is
`scrapecreators` — so the hub resolves the **shared `scrapecreators` credential** (the same
one `@workbench/tools-scrapecreators` uses). There is no separate `reddit` credential.

This is deliberate. We do not use Reddit's own API:

- The public JSON endpoints (`reddit.com/...json`) work locally but get IP-blocked (429/403)
  from datacenter hosts, so they are unreliable from the hosted hub.
- The authenticated API needs an OAuth flow we do not run server-side.

ScrapeCreators is **plumbing**; Reddit is the **domain**. The package boundary tracks the
domain — a consumer reasons about `reddit_search`, not about which vendor backs it — which is
why these tools live here rather than folded into the vendor-named `tools-scrapecreators`
package. The trade-off is that two packages share one vendor credential by design; this note
is the map pointing at that territory. Same discipline as the Gamma decision documented in
`packages/tools-gamma/README.md`.

Endpoint paths and params are verified against https://docs.scrapecreators.com and the
reference last30days skill (`mvanhorn/last30days-skill`). Update the verification comment in
`src/tools.ts` if the API changes.
