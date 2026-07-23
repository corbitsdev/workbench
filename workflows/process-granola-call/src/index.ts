import { defineWorkflow } from "@intx/workflow";
import {
  agentStep,
  deterministicToolStep,
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
// Deterministic steps use `deterministicToolStep` argMaps for the rename
// gaps native selectors cannot express (reply→body, content.title→title);
// sourceRef prefixing is server-side (write_artifact's sourceRefPrefix/
// sourceRefKey) because argMaps cannot concatenate strings.
// -------------------------------------------------------------------------

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    fetch: deterministicToolStep({
      id: "process-granola-fetch",
      title: "Fetch the transcript",
      tool: "granola_get_note",
      input: { from: "trigger.payload" },
      argMap: {
        noteId: { from: "noteId" },
      },
    }),

    transcript: deterministicToolStep({
      id: "process-granola-transcript",
      title: "Save the raw transcript",
      tool: "write_artifact",
      // fetch's output is the raw ToolResult ({ content: "<note json>" });
      // trigger.payload contributes the top-level noteId for the sourceRef.
      input: {
        merge: [{ from: "steps.fetch.output" }, { from: "trigger.payload" }],
      },
      argMap: {
        title: { fromJson: "content", field: "title" },
        titlePrefix: { literal: "Transcript — " },
        body: { from: "content" },
        kind: { literal: "research" },
        sourceRefPrefix: { literal: "granola-transcript" },
        sourceRefKey: { from: "noteId" },
        jobLabel: { literal: label },
      },
      after: ["fetch"],
    }),

    extract: agentStep({
      id: "process-granola-extract",
      title: "Extract working notes",
      systemPrompt: EXTRACT_SYSTEM_PROMPT,
      input: { from: "steps.fetch.output" },
      after: ["fetch"],
    }),

    processed: deterministicToolStep({
      id: "process-granola-processed",
      title: "Save the working notes",
      tool: "write_artifact",
      input: {
        merge: [
          { from: "steps.fetch.output" },
          { from: "steps.extract.output" },
          { from: "trigger.payload" },
        ],
      },
      argMap: {
        title: { fromJson: "content", field: "title" },
        titlePrefix: { literal: "Working notes — " },
        body: { from: "reply" },
        kind: { literal: "research" },
        sourceRefPrefix: { literal: "granola-processed" },
        sourceRefKey: { from: "noteId" },
        jobLabel: { literal: label },
      },
      after: ["extract"],
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

    persist: deterministicToolStep({
      id: "process-granola-persist",
      title: "Save the call notes",
      tool: "write_artifact",
      input: {
        merge: [
          { from: "steps.fetch.output" },
          { from: "steps.finalize.output" },
          { from: "trigger.payload" },
        ],
      },
      argMap: {
        title: { fromJson: "content", field: "title" },
        body: { from: "reply" },
        kind: { literal: "research" },
        sourceRefPrefix: { literal: "granola-call-note" },
        sourceRefKey: { from: "noteId" },
        jobLabel: { literal: label },
      },
      after: ["finalize"],
    }),
  },
});
