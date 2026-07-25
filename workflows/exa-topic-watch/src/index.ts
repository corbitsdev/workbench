import { action, awaitSignal, defineWorkflow } from "@intx/workflow";
import { agentStep, canonicalizeStepToolName } from "@workbench/agents";

export const label = "Web topic watch";
export const description =
  "On a schedule, search the web for a topic and save a short digest artifact.";
export const kind = "exa-topic-watch";

// Native `action` handler refs — the tool's canonical (factory-prefixed) name,
// resolved via the same build-time-checked lookup `deterministicToolStep`
// uses, so a typo'd or manifest-drifted tool name fails the build instead of
// deploying a step nothing can dispatch.
export const FORMAT_REPORT_DOCUMENT_HANDLER = canonicalizeStepToolName(
  "exa-topic-watch-document",
  "last30days_format_report_document",
);
export const WRITE_ARTIFACT_HANDLER = canonicalizeStepToolName(
  "exa-topic-watch-persist",
  "write_artifact",
);
export const PREPARE_SEARCH_HANDLER = canonicalizeStepToolName(
  "exa-topic-watch-prepare-search",
  "exa_topic_watch_prepare_search",
);
export const EXA_SEARCH_HANDLER = canonicalizeStepToolName(
  "exa-topic-watch-fetch",
  "exa_search",
);

/**
 * Schedule-field metadata for Routines (CL-4259). Single required topic query.
 * Mirrors the intake gate payload so scheduled runs auto-deliver without a human.
 */
export const INTAKE_FIELDS = [
  {
    name: "topic",
    label: "Topic",
    inputHint: "text" as const,
    required: true,
    help: "What to watch on the web each run.",
    placeholder: "e.g. AI coding agents for GTM",
    order: 0,
  },
] as const;

const DIGEST_SYSTEM_PROMPT = `You write short unattended web-topic digests for a scheduled watch.

You receive the watch topic and raw Exa search results (JSON research items with url, title, publishedAt, source).

Write a concise markdown digest:
1. One-line headline of what moved
2. 3–7 bullet takeaways with links where useful
3. "Worth a closer look" — 0–3 items with why

No preamble. No tool calls. Markdown body only.`;

export const workflow = defineWorkflow({
  id: kind,
  steps: {
    intake: awaitSignal({ name: "intake" }),

    // `exa_search`'s argument is `query` (shared by attio-task-agent,
    // competitor-analysis, and last30days-research — cannot rename); the
    // `document` step below needs the SAME intake field under the name
    // `topic` (`last30days_format_report_document`'s argument, shared by
    // last30days-research/firecrawl-url-watch/github-topic-watch/
    // reddit-opportunity-watch — cannot rename either). One trigger field,
    // two required argument names, both tools multi-caller. Native selectors
    // (`from`/`project`/`merge`/`literal` — `interchange/packages/workflow/
    // src/definition/selectors.ts`) can select and combine fields but cannot
    // rename or duplicate one under a second key, so there is no selector
    // that produces both `query` and `topic` from one `steps.intake.output`
    // object. Rather than alias either shared, multi-caller tool,
    // `exa_topic_watch_prepare_search` (`@workbench/workflow-exa-topic-watch`)
    // is a workflow-owned shaping tool — mirroring heartbeat's private
    // `heartbeat_*` tools — that does exactly this one rename, keeping the
    // workflow self-contained.
    "prepare-search": action({
      handler: PREPARE_SEARCH_HANDLER,
      input: {
        project: { from: "steps.intake.output" },
        fields: ["topic"],
      },
      effect: { requires: [PREPARE_SEARCH_HANDLER] },
      after: ["intake"],
    }),

    // Native `action`: `prepare-search`'s output already carries `query`,
    // exa_search's own argument name, so this step is a pure passthrough.
    fetch: action({
      handler: EXA_SEARCH_HANDLER,
      input: { from: "steps.prepare-search.output.content" },
      effect: { requires: [EXA_SEARCH_HANDLER] },
      after: ["prepare-search"],
    }),

    digest: agentStep({
      id: "exa-topic-watch-digest",
      title: "Write the digest",
      systemPrompt: DIGEST_SYSTEM_PROMPT,
      // Merge objects only (arrays fail merge selectors). Fetch tool envelope is
      // { content: ResearchItem[] }; agent sees { topic, content }.
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.fetch.output" },
        ],
      },
      after: ["fetch"],
    }),

    // Pairs the intake topic with the digest agent's reply into { title, body }
    // — the one place the agent's `reply` output field is read, so persist
    // never reshapes it. Native `action`: the former argMap (`topic: {from:
    // topic}`, `reply: {from: reply}`) was an identity passthrough, not a
    // rename — both fields already carry the tool's own argument name on the
    // merged input (intake's `topic`, the agent step's `reply`), so a plain
    // `merge` selector expresses the exact same call with no reshape step.
    document: action({
      handler: FORMAT_REPORT_DOCUMENT_HANDLER,
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.digest.output" },
        ],
      },
      effect: { requires: [FORMAT_REPORT_DOCUMENT_HANDLER] },
      after: ["digest"],
    }),

    // Persist the digest artifact. Native `action`: `title`/`body` already
    // carry write_artifact's own argument names on `document.output.content`
    // (`{ title, body }`), so `project` needs no rename; `kind`/`jobLabel`
    // were constants, expressed with one `literal`.
    persist: action({
      handler: WRITE_ARTIFACT_HANDLER,
      input: {
        merge: [
          {
            project: { from: "steps.document.output.content" },
            fields: ["title", "body"],
          },
          { literal: { kind: "research", jobLabel: label } },
        ],
      },
      effect: { requires: [WRITE_ARTIFACT_HANDLER] },
      after: ["document"],
    }),
  },
});
