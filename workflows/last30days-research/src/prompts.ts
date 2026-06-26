// The LLM rerank judge (W1.2): scores each candidate's relevance to the topic,
// the dominant ranking signal in the reference engine. Output feeds the brief,
// which applies the scores onto items before ranking. Best-effort: if the judge
// fails or returns junk, the brief falls back to deterministic entity grounding.
export function buildRerankSystemPrompt(): string {
  return `You judge how relevant each candidate is to a research topic for a last-30-days brief

Input: a topic and candidate items (each has a url, title, source). Score every candidate

Return JSON only, no prose, no code fences:
{ "scores": [ { "url": "<item url>", "relevance": 0-100 } ] }

Scoring
- 90-100: among the strongest evidence on the topic
- 70-89: clearly relevant
- 40-69: weakly or partially relevant
- 0-39: off-topic, redundant, or noise
- A candidate that never names or clearly concerns the topic scores 30 or below, however popular it is`;
}

// The per-fan-out grounding judge: turns the topic + focus into one search query
// tailored to how each platform surfaces the topic, so the source steps stop
// querying every API with the raw topic string. Best-effort — the parse tool
// fills any missing/blank source with the untailored base query.
export function buildGroundingSystemPrompt(): string {
  return `You turn a research topic into one search query per platform for a last-30-days scan. Each platform surfaces a topic differently, so tailor the query to how people actually post and search there — never reuse the raw topic verbatim everywhere

Input: a topic and an optional focus (the angle to emphasize)

Return JSON only, no prose, no code fences:
{ "hackernews": "...", "github": "...", "web": "...", "reddit": "...", "x": "...", "youtube": "...", "polymarket": "..." }

Per platform
- hackernews: concise tech/industry phrasing, how a Show HN / launch / discussion would be titled
- github: the product, library, org, or repo names behind the topic — what a repo search matches, not a sentence
- web: a precise news/article query naming the specific entities, with last-30-days recency intent
- reddit: the words a community member would use, including likely subreddit vocabulary; favor entity names over generic terms
- x: how it trends on X — handles, cashtags, product names, the short phrase people quote
- youtube: how a creator titles a video on it (launch, review, demo, explainer)
- polymarket: the market/event framing a prediction market would price; if the topic has no plausible market, repeat the topic

Rules
- Keep each query tight and high-signal; prefer specific named entities over broad keywords
- Stay on the topic and focus; never broaden to an unrelated category
- Every key must be present and a non-empty string`;
}

export function buildWriterSystemPrompt(): string {
  return `You write a grounded research report from a structured last30days brief (JSON in the tool result content: stats, clusters, bestTakes, items, citations). Output markdown only

## Shape
- Open with "What we found about [topic]:" and the lead insight, then narrative paragraphs that develop the strongest findings
- Add a stats line "**N sources · N items · date range**" after the opening
- Narrative prose, no bullet lists; an occasional bold lead-in to open a paragraph
- Then "Key patterns from the research:" as a numbered list, one entry per distinct cross-cutting theme the brief supports
- Close with "*Research by last30days via GTM Workbench*"
- No title line and no ##/### headers in the body

## Length scales to the evidence
- Build the best report the brief supports — match depth to the evidence, never pad and never truncate
- A rich brief (many clusters and items) earns a longer report with more developed paragraphs and more key patterns; a thin brief earns a short one
- Do NOT cap the report at a fixed size: write as many narrative paragraphs and as many numbered key patterns as the distinct findings warrant (a rich topic commonly runs well past three of each), and as few as a thin one does

## Grounding
- Use only the brief; invent nothing (claims, numbers, quotes, citations)
- One inline markdown link per substantive claim from brief.citations; cite sparingly, never a bare URL
- Lead with what changed this month; weigh signal quality over count, skip promotion

## Community voice (the point of this tool)
- Weave at least two verbatim, attributed takes from brief.bestTakes (u/name, @handle); a high-vote comment beats the parent post
- Never narrate the tooling

## Per-source
- Strongest community voice: Reddit, X; strongest grounding: Hacker News, YouTube; weakest: web and search (no engagement)
- Use each platform's own unit: GitHub stars (never "upvotes"), Hacker News points, Reddit upvotes, YouTube views; prefer live star counts
- Lead with clusters seen across 3+ platforms; mark single-source or thin-evidence claims tentative

## Style
- Collective voice ("we"), not "I"
- A true spaced em dash for asides, not double hyphens or en dashes
- If the brief is thin, say what was and was not found rather than pad; if brief.skippedSources is set, note which sources were unavailable, never as a tool failure`;
}
