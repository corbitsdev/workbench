import { defineWorkflow } from "@intx/workflow";
import { deterministicToolStep } from "@workbench/agents";

export const label = "Granola Call Processing";
export const description =
  "Automatic Granola call processing: on every run, discover recent calls and start one process-granola-call run per call that has no call-notes artifact yet. Bounded by maxCalls (default 10). Idempotent — already-processed calls are skipped, so a quiet run spawns nothing.";
export const kind = "granola-call";

export { DISPLAY_STEPS } from "./display-steps";

/**
 * Schedule/Routine intake field. This is the ENTIRE intake surface — no note
 * id, no channel. A run started with no inputs at all must work:
 * `granola_list_notes`'s own `limit` default (10) applies whenever `maxCalls`
 * is absent, and the spawn tool applies the same default independently.
 */
export const INTAKE_FIELDS = [
  {
    name: "maxCalls",
    label: "Max calls per run",
    inputHint: "text" as const,
    required: false,
    help: "How many recent Granola calls to look at each run (a number). Defaults to 10.",
    placeholder: "10",
    order: 0,
  },
] as const;

// -------------------------------------------------------------------------
// Fan-out parent: every step is deterministic. `discover` lists recent
// calls; `spawn` (granola_spawn_call_runs, a hub tool) parses the list in
// plain TypeScript, skips notes that already have a call-notes artifact
// (sourceRef granola-call-note-<id>), and starts one process-granola-call
// run per new note through the shared run starter. Per-call processing —
// transcript fetch, extraction, verification, artifacts — lives entirely in
// the process-granola-call child workflow, each call visible as its own run.
//
// Iteration lives in the hub tool because a deterministic step calls one
// tool once and native selectors cannot parse the list tool's JSON-string
// output into an array (`map`/`loop` cannot fan out over it); the tool is
// where "for each note" is plain code.
// -------------------------------------------------------------------------

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    discover: deterministicToolStep({
      id: "granola-call-discover",
      title: "Discover recent calls",
      tool: "granola_list_notes",
      // Every granola_list_notes arg is optional (including limit, which
      // defaults to 10 tool-side when absent) — a run started with no
      // inputs at all just works. `createdAfter` is threaded through
      // unconditionally so a future hub-side fire-time enrichment slots in
      // with no workflow change.
      input: { from: "trigger.payload" },
      argMap: {
        limit: { from: "maxCalls", optional: true },
        createdAfter: { from: "createdAfter", optional: true },
        createdBefore: { from: "createdBefore", optional: true },
        folderId: { from: "folderId", optional: true },
      },
    }),

    spawn: deterministicToolStep({
      id: "granola-call-spawn",
      title: "Start per-call processing",
      tool: "granola_spawn_call_runs",
      // discover's output is the raw ToolResult ({ content: "<json>" });
      // trigger.payload contributes the optional maxCalls cap.
      input: {
        merge: [
          { from: "steps.discover.output" },
          { from: "trigger.payload" },
        ],
      },
      argMap: {
        content: { from: "content" },
        maxCalls: { from: "maxCalls", optional: true },
      },
      after: ["discover"],
    }),
  },
});
