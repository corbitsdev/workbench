import { action, awaitSignal, defineWorkflow } from "@intx/workflow";
import { agentStep, canonicalizeStepToolName } from "@workbench/agents";

export const label = "GitHub topic watch";
export const description =
  "On a schedule, search GitHub for recent repos, issues, and PRs on a topic and save a short digest.";
export const kind = "github-topic-watch";

/**
 * Schedule-field metadata for Routines (CL-4270). Topic query + optional lookback.
 */
export const INTAKE_FIELDS = [
  {
    kind: "text",
    inputHint: "text" as const,
    name: "topic",
    label: "Topic",
    required: true,
    help: "Keyword terms only — no GitHub qualifiers (is:issue, repo:, etc.).",
    placeholder: "e.g. AI coding agents",
    order: 0,
  },
] as const;

const DIGEST_SYSTEM_PROMPT = `You write short unattended GitHub topic digests for a scheduled watch.

You receive the watch topic, optional lookback days, and raw github_activity results (JSON research items: repos, issues, PRs with url, title, publishedAt, engagement).

Write a concise markdown digest:
1. One-line headline of what moved
2. Notable repos (if any) with star/activity signal
3. Notable issues/PRs worth reading
4. "Worth a closer look" — 0–3 items with why

No preamble. No tool calls. Markdown body only.`;

// Native `action` handler refs — the tool's canonical (factory-prefixed)
// name, resolved via the same build-time-checked lookup
// `deterministicToolStep` uses, so a typo'd or manifest-drifted tool name
// fails the build instead of deploying a step nothing can dispatch.
export const GITHUB_TOPIC_WATCH_DOCUMENT_HANDLER = canonicalizeStepToolName(
  "github-topic-watch-document",
  "last30days_format_report_document",
);
export const WRITE_ARTIFACT_HANDLER = canonicalizeStepToolName(
  "github-topic-watch-persist",
  "write_artifact",
);
export const GITHUB_TOPIC_WATCH_FORMAT_ACTIVITY_QUERY_HANDLER =
  canonicalizeStepToolName(
    "github-topic-watch-format-query",
    "github_topic_watch_format_activity_query",
  );
export const GITHUB_ACTIVITY_HANDLER = canonicalizeStepToolName(
  "github-topic-watch-fetch",
  "github_activity",
);

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // Schedule wizard pre-fills and auto-delivers this gate (CL-3509).
    intake: awaitSignal({ name: "intake" }),

    // `github_activity`'s only matching argument is `query`, but the intake
    // field carries the value under `topic` (the required, user-facing
    // INTAKE_FIELDS name above). Native selectors (`from`/`project`/`merge`/
    // `literal`) can pick a field through unrenamed but have no rename
    // shape, and renaming either side is unsafe: (a) renaming the
    // workflow's intake field from `topic` to `query` would break the
    // `document` step below, which needs the SAME trigger value under the
    // name `topic` for `last30days_format_report_document` (a shared tool —
    // also called by exa-topic-watch and last30days-research); (b)
    // renaming `github_activity`'s schema arg from `query` to `topic` is
    // unsafe too — `github_activity` is a shared tool, called not just from
    // this workflow but as an LLM-invoked tool by the fannie and freddie
    // agents (`packages/agents/src/fannie/definition.ts`,
    // `packages/agents/src/freddie/definition.ts`), so it fails the
    // single-caller check required before renaming a shared tool's arg.
    //
    // The fix is a workflow-owned shaping tool (shipped in this workflow's
    // own `@workbench/workflow-github-topic-watch` package, mirroring
    // exa-topic-watch/firecrawl-url-watch/reddit-opportunity-watch's own
    // tools): `format-query` renames `topic` → `query` and stamps the fixed
    // 7-day lookback, so `fetch`'s
    // native action selector reads `steps.format-query.output.content`
    // verbatim — no argMap anywhere in this workflow.
    "format-query": action({
      handler: GITHUB_TOPIC_WATCH_FORMAT_ACTIVITY_QUERY_HANDLER,
      input: {
        project: { from: "steps.intake.output" },
        fields: ["topic"],
      },
      effect: { requires: [GITHUB_TOPIC_WATCH_FORMAT_ACTIVITY_QUERY_HANDLER] },
      after: ["intake"],
    }),

    // Native action — `format-query`'s output already carries github_activity's
    // exact `{ query, days }` argument names, so this is a pure passthrough.
    //
    // No `nonFatal` here: `fetch` is this workflow's SOLE data-gathering step
    // (`digest` reads it directly, with no alternate source), so a failure
    // — rate limit, missing PAT, network error — fails the run rather than
    // silently emitting a digest over nothing. `nonFatal` is reserved for
    // one-of-many best-effort sources (see heartbeat's intake fan-out).
    fetch: action({
      handler: GITHUB_ACTIVITY_HANDLER,
      input: { from: "steps.format-query.output.content" },
      effect: { requires: [GITHUB_ACTIVITY_HANDLER] },
      after: ["format-query"],
    }),

    digest: agentStep({
      id: "github-topic-watch-digest",
      title: "Write the digest",
      systemPrompt: DIGEST_SYSTEM_PROMPT,
      // merge requires object operands — use fetch.output (content envelope),
      // not the content array itself.
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.fetch.output" },
        ],
      },
      after: ["fetch"],
    }),

    // Native action — intake's `topic` and digest's `reply` already carry
    // the exact names `last30days_format_report_document` reads; no argMap,
    // no reshape needed.
    document: action({
      handler: GITHUB_TOPIC_WATCH_DOCUMENT_HANDLER,
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.digest.output" },
        ],
      },
      effect: { requires: [GITHUB_TOPIC_WATCH_DOCUMENT_HANDLER] },
      after: ["digest"],
    }),

    // Native action — document's { title, body } content pairs with the
    // fixed research kind/jobLabel literals write_artifact expects.
    persist: action({
      handler: WRITE_ARTIFACT_HANDLER,
      input: {
        merge: [
          { from: "steps.document.output.content" },
          { literal: { kind: "research", jobLabel: label } },
        ],
      },
      effect: { requires: [WRITE_ARTIFACT_HANDLER] },
      after: ["document"],
    }),
  },
});
