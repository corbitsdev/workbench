// The per-step system prompts for the multi-step last-30-days-research
// pipeline (CL-5879, ported from `gtm-workbench`'s `last30days-research`
// workflow — see `./index.ts`'s header comment for the full port account
// and the adaptations this file carries versus the OG source).
//
// The OG fanned grounding/gathering out across nine platforms (three web
// queries plus Hacker News, GitHub, Reddit, X, YouTube, Polymarket) with
// a dedicated entity-chasing round 2. This port keeps the OG's SHAPE —
// ground -> gather -> extract entities -> gather again -> curate -> write
// — but narrows every source list to the two platforms this deployment
// can actually reach today (`web_search`, `github_activity`; see
// `./index.ts`'s `LAST_30_DAYS_RESEARCH_WIRED_SOURCES`). The OG's
// community-voice requirements (verbatim Reddit/X quotes, per-platform
// engagement units) are softened to "when the source material has one"
// rather than a hard minimum, since neither wired source is a community
// platform the way Reddit/X/YouTube are.

// Every reasoning step's system prompt carries this so grounding/entity/
// curate/write turns spell Corbits/Corbits.dev/Interchange/Faremeter
// consistently regardless of how the source material spelled them —
// ported verbatim from the OG; the guidance is brand-correct here too.
export const CORBITS_VOCABULARY =
  "Treat Corbits, Corbits.dev, Interchange, and Faremeter as canonical Corbits names; spell them exactly. When source material contains a clear speech-to-text or spelling variant, use the canonical spelling in your output. Do not replace an ambiguous term unless surrounding context identifies it.";

/**
 * W1.1 grounding: turn the topic + focus into one tailored search query per
 * wired source, rather than every source searching the raw topic string
 * verbatim. Best-effort by construction — the next step's prompt tells the
 * gathering agent to fall back to the raw topic if a query is missing.
 */
export function buildGroundingSystemPrompt(): string {
  return `You turn a research topic into one search query per platform for a last-30-days scan. Each platform surfaces a topic differently, so tailor the query to how people actually post and search there — never reuse the raw topic verbatim on every platform.

Input: a topic and an optional focus (the angle to emphasize).

Honor the ACTION in the topic. If the topic is about launches/releases/debuts (e.g. "AI coding agents for GTM teams"), search for the EVENT — "new AI coding agent launch", "just launched" — NOT the bare category noun, which pulls generic complaint threads and "which is best?" questions instead of real news. The same holds for other actions (acquisitions, outages, funding): query the event, not just the subject.

Return JSON only, no prose, no code fences:
{ "web": "...", "github": "..." }

Per platform
- web: a news-style query naming the event, launch, or trend — short, high-signal, no year (the search already filters to recent).
- github: the product, library, org, or repo names behind the topic — what a repo search matches, not a sentence.

Rules
- Keep each query tight and high-signal.
- Stay on the topic and focus; never broaden to an unrelated category; never hardcode a year.
- Both keys must be present and a non-empty string.`;
}

/**
 * CL-2503-style entity-chasing: read round 1's raw results and name the
 * concrete launches/products/repos that actually surfaced, then write one
 * deeper follow-up query per wired source targeting those specific
 * entities rather than the broad topic again.
 */
export function buildEntityExtractSystemPrompt(): string {
  return `You read the first round of last-30-days research results and find the specific named entities worth chasing deeper — the actual product launches, company names, and repos that surfaced. Then you write one follow-up search query per platform that targets those concrete entities, NOT the broad topic again.

Input: the topic, the focus, and the first-round gathering step's raw results (whatever web_search and github_activity returned, including a plain note when a source was not reachable or not yet connected).

Method
- List the 2-5 strongest named entities the results actually surfaced — the ones a reader would want more on. Ignore generic or off-topic noise.
- If a source returned nothing usable (unreachable, not connected, or genuinely empty), repeat the base topic for that source's follow-up query rather than inventing an entity.
- Build each platform's query from the discovered entity names so round 2 returns deeper coverage of the SAME launches, not new unrelated ones.

Return JSON only, no prose, no code fences:
{ "web": "...", "github": "..." }

Rules
- Both keys present and a non-empty string; if nothing concrete surfaced, repeat the topic.
- Stay on the discovered entities; never broaden to an unrelated category.`;
}

/**
 * Folds the OG's deterministic `last30days_collect` tool (date-filter,
 * dedupe by url, drop structural junk) INTO this reasoning step, alongside
 * the OG's own curate judgment (drop promo/off-topic, group into named
 * themes, pull notable excerpts) — this port has no equivalent
 * deterministic collect tool (see `./index.ts`'s header comment), so one
 * genuine-reasoning step does both jobs instead of two.
 */
export function buildCurateSystemPrompt(): string {
  return `You are the editorial judgment for a last-30-days research brief. You receive the raw results from two rounds of web and GitHub searches and turn them into a tight, honest, deduplicated brief.

Input: the topic, the focus, and the raw gathering-step results from both rounds (each item roughly: url, title, source, publishedAt when known).

## Clean the pool first
- Drop exact and near-duplicate urls (the same story/repo surfacing in both rounds counts once).
- Drop anything clearly outside the last 30 days when a publish date is given.
- For GitHub specifically: drop pet projects, forks, template repos, and anything under roughly 50 stars unless it is clearly central to the topic — a consumer/news topic will usually keep few or no GitHub items.
- Drop bare keyword collisions — an item that merely contains the topic word but is unrelated.

## Honor the topic's intent
If the topic is about launches/releases/debuts, the PRIMARY themes are the actual launches and their coverage — name the specific products/companies that went live in the window. A general complaint or "which X is best?" item about a pre-existing product is secondary at most.

## Group into 2-5 real themes — HARD CAP 5, never one-per-item
Name themes a human would actually name: the launch, the reaction, the open question. A theme must be backed by a real named launch/event or corroboration across 2+ items — a single low-signal item is never its own theme.

## Pull notable excerpts when the material has them
If an item quotes someone or states a specific, notable claim, you may excerpt it verbatim with attribution and a url. This is optional, not required — web/GitHub results often have none; never invent one.

Return JSON only, no prose, no code fences:
{
  "themes": [
    { "title": "<specific theme name>", "summary": "<1-2 sentences on the theme and its evidence>", "itemUrls": ["<url>", "<url>"] }
  ],
  "excerpts": [
    { "quote": "<verbatim text>", "attribution": "<who or what said it>", "url": "<item url>" }
  ],
  "skippedSources": ["<source name that was unreachable or not connected>"]
}

Rules
- HARD CAP: at most 5 themes. A tight 2-theme brief beats a padded 8-theme dump.
- Every itemUrl and every excerpt.url must be a url present in the input items.
- If the pool is thin after cleaning, return fewer themes and say so in the summary rather than padding.
- List every source that was unreachable, not connected, or genuinely returned nothing in skippedSources — an honest accounting, never a silent drop.`;
}

/**
 * The final write step. Keeps this port's own established four-heading
 * report contract (Overview / Key findings / Sources consulted /
 * Citations — see `./index.ts`'s `LAST_30_DAYS_RESEARCH_SECTIONS`) rather
 * than the OG's TL;DR/per-theme-heading structure, since that contract is
 * already the one this deployment's delivery and tests commit to. Keeps
 * the OG's citation discipline, house style, and anti-fabrication rules.
 */
export function buildWriterSystemPrompt(sections: readonly string[]): string {
  const [overview, keyFindings, sourcesConsulted, citations] = sections;
  return `You write the final last-30-days research report from a curated brief (JSON: topic, themes, excerpts, skippedSources). Output ONE markdown document only, with exactly these four section headings, in order: "${String(overview)}", "${String(keyFindings)}", "${String(sourcesConsulted)}", "${String(citations)}".

## ${String(overview)}
2-4 sentences telling the real story: the concrete findings and, when present, the sharpest excerpt.

## ${String(keyFindings)}
One subsection per theme the brief supports, strongest first. Name the specific entities (products, companies, repos, numbers), weigh the evidence, and weave in any excerpts with inline links. Every claim here must trace to a citation. Note when a theme's evidence is thin; never pad, never truncate.

## ${String(sourcesConsulted)}
Name which sources were actually reached, which returned nothing or errored, and which are not yet connected (see brief.skippedSources) — an honest accounting, never a hidden failure.

## ${String(citations)}
One entry per citation used above: link plus a one-line source description.

## Grounding
- Use ONLY the brief; invent nothing (no claim, number, quote, citation, or date the brief does not contain).
- Cite inline as [label](url) using real urls from the brief's items; one link per substantive claim, never a bare URL.
- If the brief has no themes at all, say so plainly at the top of Overview ("no source results to report for this topic") instead of presenting empty or padded sections as if there were real content.

## Style
- Collective voice ("we"), not "I".
- Use " - " for asides, NOT em dashes or en dashes.
- No filler ("it's worth noting", "in conclusion"); name specifics over "many sources suggest" generalities.
- Quote exactly when the brief has an excerpt; never paraphrase one into a fake quote.
- The report stands alone: a reader who never saw the raw data understands what happened and can click through to verify.`;
}
