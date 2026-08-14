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

6. **Finalizing**: call `last_30_days_research_finalize` exactly once,
   with a short title and the report body. This call requires a human's
   approval before it completes.

## Finalizing and persistence

The agent's last act is always one call to
`last_30_days_research_finalize` (`src/finalize-tool.ts`), gated behind
a single human approval (`approval: "ask"`, the platform's native
tool-approval gate — see that file's header for the full suspend/resume
account). On approval, the call persists the report as a Library
artifact via `createWorkflowArtifact` (`src/artifact-client.ts`,
duplicated from `@corbits/artifact-tools`' client per this package's
"installable data, `@intx/*` and `arktype` only" import boundary — see
`test/boundary.test.ts`) and returns `{ id, version, title, kind,
persisted: true }`, the shape `packages/chat/src/artifact-delivery.ts`
recognizes and turns into a Library-linked chip in the thread. A failed
persist surfaces as an honest tool error, never a fabricated success.

This closes the gap this README used to document here: pain-point-
collateral and collateral-generation (CL-6000) already proved a workflow
tool package can reach the Library engine via `createWorkflowArtifact`;
that gap was stale, not a real platform limit, and this definition now
uses the same path.

This runs on both paths, not just the happy one:

- **Real report**: any wired source that returned relevant results
  feeds a normal report, finalized with a real title and the full
  markdown body.
- **No-data path**: when no wired source returns anything for the
  topic, the agent still calls `last_30_days_research_finalize` — with
  a teaching title (e.g. "Last 30 days: `<topic>` — no results yet")
  and content that honestly explains what it searched for, names the
  missing or unreachable connectors by id (`exa` for web search;
  `scrapecreators` would back a future Reddit source — see
  `packages/connections/src/registry.ts` for the live id list), and
  says what to do next. A run never ends in silence or a bare markdown
  reply — it always ends in a persisted, chip-visible artifact.

## Current limits (read before deploying)

No tool-package pin yet (CL-5999): this definition ships with
`tools: []`, same as every other workflow in this catalog, until a
production workflow builder can thread `toolPackagePins` onto a built
definition. Without a pin, `web_search` and `github_activity` are
simply absent at runtime and the report (or the no-data teaching
payload) honestly reports both as unreachable — the same degradation
path as a missing credential.

The `topic`/`focus` trigger fields have no create-time UI collection
point yet: today they only reach this workflow via a raw mail body (see
"Usage" below for the field contract), never through a routines-picker
form field. Building that collection point is a `routines-page.tsx`
stepper change owned outside this package, not a gap in this
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

### Trigger fields (`topic`, `focus`)

Every run is triggered by mail to the deployment's address
(`triggerAddress` above); the agent reads two fields off that trigger
per its system prompt:

- `topic` (required) — the free-text subject to research. Missing or
  empty `topic` gets an honest one-sentence "no topic" reply — the
  workflow never invents one.
- `focus` (optional) — narrows which angle of `topic` to chase across
  every source (e.g. `topic: "agentic coding tools"`, `focus:
"pricing changes"`).

Today the only way to set these is the raw body of the triggering mail
— there is no create-time UI field for them yet. Wiring a `topic`/
`focus` input into the routines-picker's create-time stepper
(`apps/web/src/pages/routines-page.tsx`) is a follow-up owned outside
this package, not a gap in this definition.

## Registration

Registered in `@corbits/workflow-catalog` as `last-30-days-research`
(`automatable: false` — on-demand only, gated behind a human-supplied
topic per run; not seeded by default, same as `pain-point-collateral`
and `collateral-generation`).
