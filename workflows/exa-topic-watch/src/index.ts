import { action, awaitSignal, defineWorkflow, step } from "@intx/workflow";
import { defineAgent } from "@intx/agent";

export const label = "Web topic watch";
export const description =
  "On a schedule, search the web for a topic and save a short digest artifact.";
export const kind = "exa-topic-watch";

// Tag shared with every step class, naming the step in the catalog/run-UI
// preview in place of the humanized step-map key.
const STEP_TITLE_TAG = "workbench.title";

// Corbits terminology guidance every reasoning step's system prompt carries,
// so the digest agent spells Corbits/Corbits.dev/Interchange/Faremeter
// consistently regardless of how the source material spelled them.
const CORBITS_VOCABULARY =
  "Treat Corbits, Corbits.dev, Interchange, and Faremeter as canonical Corbits names; spell them exactly. When source material contains a clear speech-to-text or spelling variant, use the canonical spelling in your output. Do not replace an ambiguous term unless surrounding context identifies it.";

// Handler refs — the tool's canonical (factory-prefixed) runtime name. Each
// literal is checked against the committed tool manifest by a repo-level test
// (`packages/tool-manifest/src/resolvable-handlers.test.ts`), so a typo'd or
// manifest-drifted handler string still fails the build rather than deploying
// a step nothing can dispatch.
export const FORMAT_REPORT_DOCUMENT_HANDLER =
  "@workbench/tools-last30days/core:last30days_format_report_document";
export const WRITE_ARTIFACT_HANDLER =
  "@workbench/tools-artifact/artifact:write_artifact";
export const PREPARE_SEARCH_HANDLER =
  "@workbench/workflow-exa-topic-watch/core:exa_topic_watch_prepare_search";
export const EXA_SEARCH_HANDLER = "@workbench/tools-exa/exa:exa_search";

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

    // Native `step({ agent })`: a plain reasoning-with-tools step built from
    // `defineAgent`, mirroring what `@workbench/agents`' `agentStep` sugar
    // wraps — no per-step model preference here, so the step uses the
    // deploy's default model.
    digest: step({
      agent: defineAgent({
        id: "exa-topic-watch-digest",
        description: "Reasoning step: exa-topic-watch-digest",
        systemPrompt: [CORBITS_VOCABULARY, DIGEST_SYSTEM_PROMPT].join("\n\n"),
        tools: [],
        capabilities: [],
        inference: { sources: [] },
        tags: { [STEP_TITLE_TAG]: "Write the digest" },
      }),
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
