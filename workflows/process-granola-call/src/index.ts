import { action, defineWorkflow } from "@intx/workflow";
import {
  agentStep,
  canonicalizeStepToolName,
  LLM_WRITER_MODEL,
} from "@workbench/agents";

export const label = "Process Granola Call";
export const description =
  "Process one Granola call end to end: fetch the transcript, save it as a raw artifact, extract working notes with a large-context model, then verify and publish the final call notes. Spawned per call by the granola-call parent; safe to re-run — every artifact upserts in place.";
export const kind = "process-granola-call";

export { DISPLAY_STEPS } from "./display-steps";

/** One call per run — the parent fanout passes exactly one noteId. */
export const INTAKE_FIELDS = [
  {
    name: "noteId",
    label: "Granola note id",
    inputHint: "text" as const,
    required: true,
    help: "The Granola note (call) this run processes.",
    placeholder: "note_...",
    order: 0,
  },
] as const;

const EXTRACT_SYSTEM_PROMPT = `You extract working notes from one Granola call transcript.

You receive the raw granola_get_note result (JSON: the full note, including its transcript). Read the whole transcript.

Output a raw markdown working document with exactly these sections:
## Participants
Who was on the call (names and, when stated, roles/companies).
## Summary
One or two plain paragraphs of what the call covered.
## Pain points
## Decisions
## Action items
Each of the last three: a short bullet list grounded in the transcript. Write "None noted" when the transcript shows none. Quote or closely paraphrase the transcript — do not invent.

This is a working document for a later verification pass, not a polished deliverable. No preamble. Markdown only.`;

const FINALIZE_SYSTEM_PROMPT = `You produce the final call-notes document for one Granola call.

You receive (JSON fields):
- "content": the raw granola_get_note result — the full note with its transcript. Ground truth.
- "reply": a working document extracted from that transcript (sections: Participants, Summary, Pain points, Decisions, Action items).

Verify the working document against the transcript: fix anything unsupported, misattributed, or missing. Then output the final markdown document with the same five sections, polished and accurate. Keep claims grounded in the transcript; when the transcript is ambiguous, say so rather than guessing.

Your reply is saved verbatim as the final call-notes artifact. No preamble. Markdown only.`;

// Native `action` handler refs — the tool's canonical (factory-prefixed) name,
// resolved via `canonicalizeStepToolName`'s build-time-checked lookup, so
// a typo'd or manifest-drifted tool name fails the build instead of
// deploying a step nothing can dispatch.
export const GRANOLA_GET_NOTE_HANDLER = canonicalizeStepToolName(
  "process-granola-fetch",
  "granola_get_note",
);
export const WRITE_ARTIFACT_HANDLER = canonicalizeStepToolName(
  "process-granola-persist",
  "write_artifact",
);
export const PREPARE_DOCUMENT_HANDLER = canonicalizeStepToolName(
  "process-granola-prepare-document",
  "process_granola_prepare_document",
);

// -------------------------------------------------------------------------
// Per-call child workflow (the granola-call parent starts one run per new
// note). Artifact chain per call, all keyed by noteId so re-runs upsert in
// place via write_artifact's (tenantId, sourceRef) dedupe:
//
//   1. transcript  sourceRef granola-transcript-<noteId>  — raw note JSON
//   2. working doc sourceRef granola-processed-<noteId>   — extract output
//   3. call notes  sourceRef granola-call-note-<noteId>   — finalize output
//
// Model cascade: `extract` runs on the deploy default (the cheap
// large-context model) over the FULL transcript; `finalize` runs on the
// writer model, verifying the working doc against the transcript before
// emitting the final document. Fact-check and polish are deliberately ONE
// stage — split only if hallucinations survive into final artifacts.
//
// Native `action` dispatch passes its evaluated `input` selector verbatim as
// the tool's arguments, and selectors (`from`/`project`/`merge`/`literal`)
// cannot rename or duplicate a field. Each write_artifact call needs `title`
// pulled out of the raw note JSON (a `fromJson` extract), `body` renamed
// from `content`/`reply`, and — for the two lineage writes — the SAME
// noteId duplicated under both `sourceRefKey` and `parentSourceRefKey`. None
// of that is selector-expressible, so a `prepare-*` action ahead of each
// write shapes it via this workflow's own `process_granola_prepare_document`
// tool (@workbench/workflow-process-granola-call); the write_artifact action
// itself then only merges that shaped output with the step's constant
// literals (titlePrefix/kind/sourceRefPrefix/parentSourceRefPrefix/jobLabel).
// -------------------------------------------------------------------------

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // Native action: granola_get_note's sole argument is `noteId`, which is
    // also trigger.payload's own field name (INTAKE_FIELDS) — a pure
    // passthrough, no reshape needed.
    fetch: action({
      handler: GRANOLA_GET_NOTE_HANDLER,
      input: { from: "trigger.payload" },
      effect: { requires: [GRANOLA_GET_NOTE_HANDLER] },
    }),

    "prepare-transcript": action({
      handler: PREPARE_DOCUMENT_HANDLER,
      // fetch's output is the raw ToolResult ({ content: "<note json>" });
      // trigger.payload contributes the top-level noteId. No `reply` here,
      // so the tool falls back to `content` as the transcript's own body.
      input: {
        merge: [{ from: "steps.fetch.output" }, { from: "trigger.payload" }],
      },
      effect: { requires: [PREPARE_DOCUMENT_HANDLER] },
      after: ["fetch"],
    }),

    transcript: action({
      handler: WRITE_ARTIFACT_HANDLER,
      input: {
        merge: [
          { from: "steps.prepare-transcript.output.content" },
          {
            literal: {
              titlePrefix: "Transcript — ",
              kind: "research",
              sourceRefPrefix: "granola-transcript",
              jobLabel: label,
            },
          },
        ],
      },
      effect: { requires: [WRITE_ARTIFACT_HANDLER] },
      after: ["prepare-transcript"],
    }),

    extract: agentStep({
      id: "process-granola-extract",
      title: "Extract working notes",
      systemPrompt: EXTRACT_SYSTEM_PROMPT,
      input: { from: "steps.fetch.output" },
      after: ["fetch"],
    }),

    "prepare-processed": action({
      handler: PREPARE_DOCUMENT_HANDLER,
      input: {
        merge: [
          { from: "steps.fetch.output" },
          { from: "steps.extract.output" },
          { from: "trigger.payload" },
          { literal: { includeParent: true } },
        ],
      },
      effect: { requires: [PREPARE_DOCUMENT_HANDLER] },
      after: ["fetch", "extract"],
    }),

    processed: action({
      handler: WRITE_ARTIFACT_HANDLER,
      input: {
        merge: [
          { from: "steps.prepare-processed.output.content" },
          {
            literal: {
              titlePrefix: "Working notes — ",
              kind: "research",
              sourceRefPrefix: "granola-processed",
              // Lineage: working notes descend from the raw transcript, so
              // the chain renders as a linked family (write_artifact
              // resolves the parent by its composed sourceRef; best-effort
              // server-side).
              parentSourceRefPrefix: "granola-transcript",
              jobLabel: label,
            },
          },
        ],
      },
      effect: { requires: [WRITE_ARTIFACT_HANDLER] },
      // transcript is an explicit dependency: the parent lookup is a plain
      // read at write time, so the parent artifact must exist BEFORE this
      // step runs — sibling DAG branches run concurrently otherwise and the
      // lineage silently loses the race.
      after: ["prepare-processed", "transcript"],
    }),

    finalize: agentStep({
      id: "process-granola-finalize",
      title: "Verify and write call notes",
      systemPrompt: FINALIZE_SYSTEM_PROMPT,
      model: LLM_WRITER_MODEL,
      // Without an explicit ceiling the source's small default truncates the
      // call notes mid-sentence at finish_reason "length" (observed in
      // production: a document cut off inside "Pain points"). Same ceiling
      // the other writer-model steps use (gtm-scripts-briefs,
      // last30days-research).
      maxTokens: 16384,
      input: {
        merge: [
          { from: "steps.fetch.output" },
          { from: "steps.extract.output" },
        ],
      },
      after: ["extract"],
    }),

    "prepare-persist": action({
      handler: PREPARE_DOCUMENT_HANDLER,
      input: {
        merge: [
          { from: "steps.fetch.output" },
          { from: "steps.finalize.output" },
          { from: "trigger.payload" },
          { literal: { includeParent: true } },
        ],
      },
      effect: { requires: [PREPARE_DOCUMENT_HANDLER] },
      after: ["fetch", "finalize"],
    }),

    persist: action({
      handler: WRITE_ARTIFACT_HANDLER,
      input: {
        merge: [
          { from: "steps.prepare-persist.output.content" },
          {
            literal: {
              kind: "research",
              sourceRefPrefix: "granola-call-note",
              // Lineage: the final call notes descend from the working notes.
              parentSourceRefPrefix: "granola-processed",
              jobLabel: label,
            },
          },
        ],
      },
      effect: { requires: [WRITE_ARTIFACT_HANDLER] },
      // processed is an explicit dependency for the same lineage-race
      // reason as transcript above.
      after: ["prepare-persist", "processed"],
    }),
  },
});
