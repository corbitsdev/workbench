# last30days Skill

## Intent Parse

Before calling any tools, identify:

- **TOPIC** — normalized research subject (e.g. "Rust async runtimes", "AI coding tools")
- **queryType** — one of: GENERAL | NEWS | COMPARISON | RECOMMENDATIONS
  - COMPARISON: extract the entities being compared
  - RECOMMENDATIONS: extract the outcome category (e.g. "fastest CI", "cheapest GPU cloud")
  - GENERAL or NEWS: proceed directly
- If the request is genuinely ambiguous, ask ONE clarifying question before proceeding. Do not ask if the intent is clear.

## Orchestration

Follow this exact tool-call sequence every time:

### Step 1 — Entity extraction

Call `last30days_core_extract` with the normalized topic string. This returns handles, repos, subreddits, and hashtags to sharpen downstream queries. Larry is the query planner — sharpen per-source queries from this output before fanning out.

### Step 2 — Parallel source fetch

Call the source tools concurrently. Pass sharpened queries from Step 1 and `days` (default 30 unless the user specifies otherwise). Always call the core sources; add the conditional sources when the topic fits.

Core sources (always call):

- `hackernews_search` — recent HN posts and comments
- `github_activity` — repository stars, releases, issues
- `web_search` — broad web coverage (`exa_search` is the same capability; either name works, pass just a query)
- `reddit_search` and `reddit_subreddit_search` — community discussion (use subreddits from Step 1)
- `x_search` — real-time discussion and reactions on X

Conditional sources (call when relevant):

- `youtube_search` — video coverage with transcripts and top comments; call for product, tutorial, review, or creator topics where video discussion matters
- `bluesky_search` — real-time discussion on Bluesky; call alongside `x_search` for tech, news, and culture topics
- `polymarket_odds` — only when the topic has a prediction-market angle (events, outcomes, elections, prices); weight odds prominently in the synthesis
- `scrapecreators_tiktok`, `scrapecreators_instagram`, `scrapecreators_threads`, `scrapecreators_pinterest` — for consumer, cultural, product, or creator-economy topics where social reception matters; skip them for narrow developer-infrastructure topics

A source that errors or has no credential configured returns no items. Continue with whatever the other sources return and never abort the report because one source failed.

### Step 3 — Report

Call `last30days_core_report` with all raw items from Step 2 concatenated, plus `{ topic, days, topK: 20 }`. The tool returns a structured brief:

```
{ topic, days, queryType?, stats: { sourceCount, itemCount, dateRange: { from, to } }, leadInsight?, clusters: [{ id, title, score, sources[], items[], summary? }], bestTakes: [{ quote, author?, source, engagement, url }], items[], citations[] }
```

**Report tool input/output contract:**

- `topic` is a required non-empty string; never omit it
- `rawItems` MUST be a real JSON array passed as a JavaScript array — never a stringified blob (do not call `JSON.stringify` on the items before passing them)
- Per-item shape: `{ url, title, publishedAt, source, engagement?, ... }` — `engagement` (`{ upvotes, comments }`) is included ONLY for sources that provide it (github, reddit, youtube, hn) and OMITTED entirely for sources that do not (web, x)
- The returned brief is passed verbatim as `data: brief` to `write_artifact` — do not re-serialize or mutate it

### Step 4 — Validate

Call `last30days_validate` with `{ body: <synthesized text>, citations: brief.citations, returnedItemUrls: <all item URLs from brief> }`.

- If rejected: retry synthesis once, incorporating `rejectionReason` from the response
- If still rejected after one retry: flag the output as draft and continue

### Step 5 — Persist

Call `write_artifact` with:

```
{ title: topic, body: <synthesized prose>, citations: brief.citations, kind: 'research', data: brief }
```

Always pass `data: brief` — the full structured brief object. Always pass `citations` from the brief, never from model memory.

## Synthesis Rules

**Per-source weighting:**

- HN and Reddit: weight top-voted comments and high-engagement threads; quote verbatim with vote/like counts where notable
- X: weight posts with high engagement; quote verbatim with like/retweet counts
- Prediction markets: weight odds as primary signal when `polymarket_odds` was called
- GitHub: weight release notes and issue velocity as signals of momentum

**Best Takes weaving:**

If `brief.bestTakes` is non-empty, weave 2-3 of the highest-engagement quotes directly into the narrative prose, attributed with counts. Do NOT create a separate "Best Takes" section — integrate them as evidence within the body paragraphs.

**ELI5 mode:**

If the user asks for ELI5 or simpler language, rewrite the entire synthesis in plain, accessible language. Avoid jargon. Do not make it childish — just clear and direct.

## queryType Contracts

**GENERAL / NEWS:** narrative prose covering the top clusters in order of score.

**COMPARISON:**

1. Quick verdict sentence
2. One paragraph per entity, grounded in cluster evidence
3. Head-to-head paragraph on the key differentiator
4. Bottom line: one sentence recommendation

**RECOMMENDATIONS:**

1. Signal-weighted winner up front
2. Justify with cluster evidence and engagement signals
3. Close with any meaningful caveats

## Format Laws

Structure the synthesized body as follows:

1. **Lead line**: "What I learned about [TOPIC]:" followed by `brief.leadInsight` (or the top cluster title if leadInsight is absent)
2. **Stats block**: `**[N] sources · [N] items · [date range]**` on its own line, populated from `brief.stats`
3. **Body**: narrative prose derived from `brief.clusters` summaries and bestTakes. No bullet lists. Every claim gets an inline `[title](url)` citation drawn from `brief.citations`
4. **Footer**: last line is `*Research by last30days via GTM Workbench*`

Additional rules:

- No em-dashes anywhere in the output
- Do not invent citations — every link must come from `brief.citations`
- Write body synthesis FROM the brief (clusters, summaries, bestTakes) — do not hallucinate claims
