import { action, awaitSignal, defineWorkflow, step } from "@intx/workflow";
import { defineAgent } from "@intx/agent";

export const label = "Scrape for stories";
export const description =
  "On a schedule, search the web for configured topics, rank story candidates, and save a shared story-bucket artifact for Daily LinkedIn — no mid-run human gates.";
export const kind = "scrape-for-stories";

/** Stable artifact kind Daily LinkedIn (and peers) list against. */
export const STORY_BUCKET_ARTIFACT_KIND = "story-bucket";

/**
 * Tenant-scoped identity for the shared bucket. `write_artifact` returns the
 * existing artifactId for a re-write with the same tenant + `sourceRef`, so a
 * weekly re-run updates one row instead of colliding on the
 * (principalId, title, kind) fallback and stacking duplicates.
 */
export const STORY_BUCKET_SOURCE_REF = "story-bucket-latest";

// The bucket's artifact title. `last30days_format_report_document` titles the
// document from its `topic` argument; this workflow ranks ACROSS the scheduled
// topics into one bucket, so no single topic is the title — a stable product
// label is, and it keeps the sourceRef-matched row's title stable across runs.
const STORY_BUCKET_TITLE = "Story bucket";

// Tag shared with every step class, naming the step in the catalog/run-UI
// preview in place of the humanized step-map key.
const STEP_TITLE_TAG = "workbench.title";

// Corbits terminology guidance the collect step's system prompt carries, so
// the bucket spells Corbits/Corbits.dev/Interchange/Faremeter consistently
// regardless of how the source material spelled them.
const CORBITS_VOCABULARY =
  "Treat Corbits, Corbits.dev, Interchange, and Faremeter as canonical Corbits names; spell them exactly. When source material contains a clear speech-to-text or spelling variant, use the canonical spelling in your output. Do not replace an ambiguous term unless surrounding context identifies it.";

// The tenant-resolved inference source the collect step uses, and the heavier
// model it opts into — ranking and writing the bucket is editorial judgment.
const LLM_CREDENTIAL_NAME = "opencode-zen";
const LLM_PROVIDER = "openai-compatible";
const LLM_WRITER_MODEL = "kimi-k2.6";

// Handler / capability refs — each is the tool's canonical
// `<factoryId>:<bareName>` runtime name, hardcoded literally.
// `packages/tool-manifest/src/resolvable-handlers.test.ts` checks every
// committed workflow def's handler strings against the committed tool
// manifest, so a typo'd or manifest-drifted string fails the build rather
// than deploying a step nothing can dispatch.
export const EXA_SEARCH_HANDLER = "@workbench/tools-exa/exa:exa_search";
export const FORMAT_REPORT_DOCUMENT_HANDLER =
  "@workbench/tools-last30days/core:last30days_format_report_document";
export const WRITE_ARTIFACT_HANDLER =
  "@workbench/tools-artifact/artifact:write_artifact";

/**
 * Schedule-field metadata for Routines (CL-4430). Topics stay on the schedule
 * (tenant config), not hard-coded in the pack — keeps the workflow
 * transportable. Payload validates against `ScrapeForStoriesIntakePayloadSchema`
 * at the `/resume` boundary.
 */
export const INTAKE_FIELDS = [
  {
    name: "topics",
    label: "Topics",
    inputHint: "string-array" as const,
    required: true,
    help: "Topic queries to scrape each run. Each entry is searched; the agent ranks across them into one story bucket.",
    placeholder: "AI coding agents for GTM",
    order: 0,
  },
] as const;

const COLLECT_SYSTEM_PROMPT = `You build an unattended weekly story bucket for a GTM content team.

You receive intake with a "topics" array (one or more search queries).

For each topic, call exa_search once (query = that topic string). Prefer recent, linkable public items. If a search fails or returns nothing, skip that topic and continue — never invent results.

Then write ONE markdown story bucket as your final reply (no tool calls in the final message):

# Story bucket
Brief one-line window summary.

## Ranked stories
For each of 5–12 stories (or fewer if thin week), a bullet with:
- **Headline** — link
- Why it matters for GTM / content (one sentence)
- Source topic tag if multi-topic

## Thin / empty
If almost nothing landed, say so plainly under a short section and list what was attempted. Still produce valid markdown.

Rules:
- No mid-run human selection — pick and rank yourself.
- No preamble, no JSON, no tool-call narration in the final body.
- Prefer primary sources and concrete claims over fluff.
- Degrade cleanly: empty or partial search still yields a short honest bucket.`;

// Tool-using collect agent. `exa_search` is declared as a CAPABILITY, not
// dispatched by an `action` step: the topic list is variable-length, and a
// dead or rate-limited search on one topic must degrade to a recorded skip in
// the bucket rather than fail the run. A native `action` has no error-swallow
// (a thrown tool error inside `ctx.perform` propagates and fails the run —
// `apps/sidecar/src/action-tool-handler.ts`), whereas a tool error inside an
// agent turn comes back to the agent as a failed call it reasons past, which
// is exactly the per-topic tolerance this workflow needs. Capabilities only —
// never inline tool factories (the definition is pushed as JSON).
const collectAgent = defineAgent({
  id: "scrape-for-stories-collect",
  description:
    "Searches configured topics via Exa and ranks a story-bucket markdown digest.",
  systemPrompt: [CORBITS_VOCABULARY, COLLECT_SYSTEM_PROMPT].join("\n\n"),
  tools: [],
  capabilities: [EXA_SEARCH_HANDLER],
  inference: {
    sources: [{ provider: LLM_PROVIDER, model: LLM_WRITER_MODEL }],
  },
  tags: {
    credentialName: LLM_CREDENTIAL_NAME,
    [STEP_TITLE_TAG]: "Search and rank stories",
  },
});

export const workflow = defineWorkflow({
  id: kind,
  steps: {
    // Unattended: the schedule supplies intake; no mid-run HITL after this.
    intake: awaitSignal({ name: "intake" }),

    collect: step({
      agent: collectAgent,
      input: { from: "steps.intake.output" },
      after: ["intake"],
    }),

    // Pairs the bucket's stable title with the collect agent's reply into the
    // { title, body } document persist needs — the one place the agent's
    // `reply` output field is read, so persist never reshapes it. Native
    // `action`: `reply` already carries the tool's own argument name on
    // `collect.output`, and `topic` is a constant, so a `merge` of one
    // `project` and one `literal` expresses the exact call with no reshape.
    document: action({
      handler: FORMAT_REPORT_DOCUMENT_HANDLER,
      input: {
        merge: [
          { literal: { topic: STORY_BUCKET_TITLE } },
          { project: { from: "steps.collect.output" }, fields: ["reply"] },
        ],
      },
      effect: { requires: [FORMAT_REPORT_DOCUMENT_HANDLER] },
      after: ["collect"],
    }),

    // Persist the shared bucket. Native `action`, fatal-only (a persist
    // failure must fail the run): `title`/`body` already carry write_artifact's
    // own argument names on `document.output.content`, and
    // `kind`/`jobLabel`/`sourceRef` are constants.
    persist: action({
      handler: WRITE_ARTIFACT_HANDLER,
      input: {
        merge: [
          {
            project: { from: "steps.document.output.content" },
            fields: ["title", "body"],
          },
          {
            literal: {
              kind: STORY_BUCKET_ARTIFACT_KIND,
              jobLabel: label,
              sourceRef: STORY_BUCKET_SOURCE_REF,
            },
          },
        ],
      },
      effect: { requires: [WRITE_ARTIFACT_HANDLER] },
      after: ["document"],
    }),
  },
});
