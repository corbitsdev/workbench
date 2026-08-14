# @corbits/last-30-days-research-workflow

A single mail-triggered step that researches a topic across the last 30
days over a handful of source platforms and writes it up as one
long-form, cited research report (CL-5997, ported from `gtm-workbench`'s
`last30days-research` workflow, child of CL-5987's routines-catalog
port).

## Scoped down for the first port

The OG fanned out across seven source platforms in parallel: Hacker
News, GitHub, web search (Exa), Reddit, X, YouTube, and Polymarket
(Bluesky was wired in the OG source but disabled there for broken auth —
it never counted as a live source, so this port skips it entirely rather
than naming it pending). Almost none of those source integrations exist
in the workbench/corbitsdev ecosystem yet; building all seven at once
would block the whole workflow on the size of that gap list.

This first port wires the two sources with a real, honest backend ready
today, and lands the rest as tool packages become available:

| Source      | Status            | Tool package                                                                            |
| ----------- | ----------------- | --------------------------------------------------------------------------------------- |
| Web search  | wired             | `@corbits/web-search-tools` (Exa-backed)                                                |
| GitHub      | wired             | `@corbits/github-tools` (public REST search)                                            |
| Hacker News | not yet connected | no workbench tool package yet                                                           |
| Reddit      | not yet connected | no workbench tool package yet (same gap noted on the Reddit opportunity-scanner ticket) |
| X           | not yet connected | `corbitsdev/x-tools` exists as a named package but is currently an empty stub           |
| YouTube     | not yet connected | no workbench tool package yet                                                           |
| Polymarket  | not yet connected | no workbench tool package yet                                                           |

Web search was chosen over Exa's package name specifically because the
OG's own `web_search` tool name is provider-agnostic by design — the
agent reasons about "web search," not "Exa vs. some other provider."
GitHub's public search REST API works with no credential at all (lower
rate limit, not "not connected"), so it needed no credential gate to be
honest about today.

## What it does

One step, one agent, matching every other definition in this catalog.
The system prompt (`LAST_30_DAYS_RESEARCH_SYSTEM_PROMPT`) commits it to:

1. **Intake**: read `topic` (required) and an optional `focus` off the
   trigger. No topic means an honest one-sentence "nothing to research"
   reply, never an invented topic.
2. **Grounding**: work out one tailored query per wired source.
3. **Gathering**: call `web_search` and `github_activity` (when
   available), each at most once. A tool error degrades that source to
   "not reachable right now," never a failed run and never invented
   results.
4. **Synthesis**: rerank gathered results for relevance and fold them
   into a brief before writing.
5. **Report**: exactly four markdown section headings, in order —
   **Overview**, **Key findings**, **Sources consulted**, **Citations**.
   Every claim in Key findings must trace to a citation. Sources
   consulted names which sources were actually reached, which errored,
   and which are not yet connected — an honest accounting per source,
   never a silently degraded "not available."

Grounding, gathering, and synthesis are folded directly into this one
system prompt rather than the OG's several bespoke workflow-local tools
(`last30days_ground_queries`, `last30days_collect`,
`last30days_core_report`, ...) — none of that logic is a reusable
integration on its own, matching the `morning-brief`/`pain-point-
collateral`/`collateral-generation` convention already established in
this catalog.

## Current limits (read before deploying)

Same category of gap `@corbits/collateral-generation-workflow`'s README
documents (CL-6000): no workflow tool package in this repo can reach the
Library engine yet, so this definition does not attempt to persist the
report as a Library artifact. The finished report still reaches the
human as the delivered chat reply — persisting it as a Library row is a
follow-up once CL-6000 closes, not a redesign of this definition.

No tool-package pin either (CL-5999): this definition ships with
`tools: []`, same as every other workflow in this catalog, until a
production workflow builder can thread `toolPackagePins` onto a built
definition.

## Usage

```ts
import {
  buildLast30DaysResearchWorkflow,
  serializeLast30DaysResearchWorkflow,
} from "@corbits/last-30-days-research-workflow";

const definition = buildLast30DaysResearchWorkflow({
  triggerAddress: "last-30-days-research@tenant.example",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 300_000,
});

const json = serializeLast30DaysResearchWorkflow(definition);
```

Pin `@corbits/web-search-tools` (needs a `webSearchApiKey`, i.e. an Exa
key) and `@corbits/github-tools` (works keylessly, or with a
`githubApiKey` for a higher rate limit) on the deployment for the agent
to reach real data — without a pin, every tool call is simply absent and
the report honestly reports both as unreachable.

## Registration

Registered in `@corbits/workflow-catalog` as `last-30-days-research`
(`automatable: false` — on-demand only, gated behind a human-supplied
topic per run; not seeded by default, same as `pain-point-collateral`
and `collateral-generation`).
