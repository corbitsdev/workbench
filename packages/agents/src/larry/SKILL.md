# last30days Skill

## Intent Parse

Before calling any tools, identify:

- **TOPIC** — normalized research subject (e.g. "Rust async runtimes", "AI coding tools")
- **Query type** — one of: RECOMMENDATIONS | NEWS | COMPARISON | GENERAL
  - COMPARISON: extract the entities being compared
  - RECOMMENDATIONS: extract the outcome category (e.g. "fastest CI", "cheapest GPU cloud")
  - GENERAL or NEWS: proceed directly
- If the request is ambiguous, ask one clarifying question before proceeding.

## Orchestration

Follow this exact tool-call sequence every time:

### Step 1 — Entity extraction

Call `last30days_core_extract` with the normalized topic string. This returns handles, repos, subreddits, and hashtags to sharpen downstream queries.

### Step 2 — Parallel source fetch

Call all four source tools concurrently. Pass sharpened queries from Step 1 and `days` (default 30 unless the user specifies otherwise):

- `hackernews_search` — recent HN posts and comments
- `github_activity` — repository stars, releases, issues
- `polymarket_odds` — prediction market signals
- `exa_search` — broad web coverage

### Step 3 — Report

Call `last30days_core_report` with all raw items from Step 2 concatenated, plus `{ topic, days, topK: 20 }`. Receive a ranked Report with cluster summaries and a citations array.

### Step 4 — Validate

Call `last30days_validate` with `{ body: <synthesized text>, citations: report.citations, returnedItemUrls: <all item URLs from Report> }`.

- If rejected: retry synthesis once, incorporating `rejectionReason` from the response.
- If still rejected after one retry: flag the output as draft and continue.

### Step 5 — Persist

Call `write_artifact` with `{ title: topic, body: validated.body, citations: report.citations, kind: 'research' }`.

Always pass `citations` from the Report object — never from model memory.

## Format Discipline

Structure the synthesized body as follows:

1. **Lead line**: "What I learned about [TOPIC]:" followed by the single top insight.
2. **Stats block**: `**[N] sources · [N] items · [date range]**` on its own line.
3. **Body**: narrative prose derived from cluster summaries. No bullet lists. Every claim gets an inline `[title](url)` citation drawn from the citations array.
4. **Footer**: last line is `*Research by last30days via GTM Workbench*`.

Additional rules:
- No em-dashes anywhere in the output.
- Do not invent citations — every link must come from the citations array returned by `last30days_core_report`.
- For COMPARISON queries, cover each entity in its own paragraph before a closing synthesis paragraph.
- For RECOMMENDATIONS queries, lead with the winning recommendation, then justify with evidence.
