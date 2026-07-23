import { defineWorkflow } from "@intx/workflow";
import { agentStep, deterministicToolStep } from "@workbench/agents";

export const label = "Granola Call Processing";
export const description =
  "Automatic Granola call processing: on every run, discover recent calls and publish a digest. Bounded by maxCalls (default 10). Idempotent — a quiet run is a clean no-op, and reruns never duplicate output (CL-4283).";
export const kind = "granola-call";

export { DISPLAY_STEPS } from "./display-steps";

/**
 * Schedule/Routine intake field (CL-4283 redesign). This is the ENTIRE
 * intake surface — no note id, no channel. A run started with no inputs at
 * all must work: `granola_list_notes`'s own `limit` default (10) applies
 * whenever `maxCalls` is absent, so the tool call below never needs a
 * workflow-level default either.
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

const DIGEST_SYSTEM_PROMPT = `You write a short unattended digest for a Granola call-processing run.

You receive the raw granola_list_notes result (JSON: notes[], hasMore, cursor?) for the most recent notes, bounded by the run's maxCalls.

Write a concise markdown digest:
1. One-line headline: how many calls were found (0 is fine — say so plainly, e.g. "No new calls since the last run.")
2. For each call: title, created date, and a short one-paragraph summary of what the call covered and any notable pain points, decisions, or action items visible in its transcript/summary field
3. Keep each call's writeup independent — this is per-call ground truth, not a single blended narrative

No preamble. No tool calls. Markdown body only.`;

// -------------------------------------------------------------------------
// Workflow definition (CL-4283 redesign, per direct product direction):
// Granola call processing is AUTOMATIC call processing. It discovers recent
// calls itself; it does not take a `noteId` from whoever starts it. The
// only input is `maxCalls` (optional, default 10).
//
// Step graph:
//   discover  deterministicToolStep  granola_list_notes (RETAINED — see below)
//   digest    agentStep (native reasoning step) — per-call writeup
//   persist   deterministicToolStep  write_artifact (RETAINED — see below)
//
// Both retained steps are deliberate, individually-justified exceptions —
// NOT a refusal to migrate. Every step this workflow needs is one of these
// two shapes, and native `action`'s selector vocabulary (`from`/`project`/
// `merge`/`literal`) cannot express either:
//
// 1. `discover` — `maxCalls` (the product-facing intake field name) must
//    become `granola_list_notes`'s `limit` argument. No selector shape
//    renames a field into a new key — `project` keeps a source field's own
//    name, `merge` only combines objects preserving their keys. Renaming
//    requires `deterministicToolStep`'s `argMap` (`limit: { from: "maxCalls",
//    optional: true }` — omitted entirely when absent, so the tool's own
//    default (10) applies exactly when `maxCalls` is unset).
//
// 2. `persist` — the digest agent step's output is the step invoker's
//    `{ reply, turn }` (workflow-host `stepResultFromSend`; the same field
//    every sibling workflow reads — exa-topic-watch, firecrawl-url-watch,
//    github-topic-watch, gamma-presentation-creator). `write_artifact`
//    requires `title`/`body`/`kind` fields. Same rename gap: nothing reads
//    `reply` and writes it under `body` except `argMap`.
//
// Dedup / "already processed" (per direct instruction: reuse an existing
// shape rather than invent one). Heartbeat's reference shape is a fire-time
// `createdAfter` HUB enrichment (`apps/hub/src/lib/heartbeat-trigger-
// payload.ts`) stamped onto `trigger.payload` before the run starts — that
// enrichment is apps/hub code, outside this PR's touch scope
// (workflows/granola-call only). This workflow still honors an optional
// `trigger.payload.createdAfter` (passed straight through to
// `granola_list_notes`, which already supports it — see `discover`'s
// argMap) so a future hub-side enrichment slots in with no workflow change.
// Until that lands, "already processed" is enforced the way every
// persisted Granola-call artifact already dedupes: `write_artifact`'s
// `(tenantId, sourceRef)` uniqueness. This workflow's digest uses a STABLE
// sourceRef, so a run over an unchanged note set upserts the same artifact
// in place — a quiet run produces no new side effects, satisfying "already
// processed calls not repeated" / "clean no-op" with the dedupe mechanism
// this codebase already has rather than a new one.
//
// Scope gap, flagged loudly: this ships ONE digest artifact per run (all
// discovered calls, up to maxCalls, written up individually inside it) —
// not a separate typed pain-points/summary/brief artifact PLUS tasks PLUS
// mail fanout per call, the way the old single-note pipeline did. True
// per-call fan-out needs a `map` whose `over` selector reads a real array;
// every `tools-granola` workflow tool returns `kind: "string"` (JSON-
// stringified content) — native selectors cannot parse a JSON string into
// an array, and `deterministicToolStep`'s `argMap.fromJson` only extracts a
// flat top-level field, never an array index or a second level of nesting.
// Verified against the real `@intx/workflow` runtime and `tools-granola`
// source (not assumed) via this package's `cl-4283.test.ts`. Fixing this
// needs a `packages/tools-granola` change (a `kind: "full"` structured
// note-list tool) or upstream `map`/selector JSON-parsing support — both
// out of this PR's touch scope. Filed as a follow-up in the PR description.
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
      // unconditionally (never absent-throws — it's genuinely optional
      // both here and on the tool) so a future hub-side fire-time
      // enrichment (see module comment) slots in with no workflow change.
      input: { from: "trigger.payload" },
      argMap: {
        limit: { from: "maxCalls", optional: true },
        createdAfter: { from: "createdAfter", optional: true },
        createdBefore: { from: "createdBefore", optional: true },
        folderId: { from: "folderId", optional: true },
      },
    }),

    digest: agentStep({
      id: "granola-call-digest",
      title: "Write the call digest",
      systemPrompt: DIGEST_SYSTEM_PROMPT,
      input: { from: "steps.discover.output" },
      after: ["discover"],
    }),

    persist: deterministicToolStep({
      id: "granola-call-persist",
      title: "Save the call digest",
      tool: "write_artifact",
      input: { from: "steps.digest.output" },
      argMap: {
        title: { literal: "Granola calls — digest" },
        body: { from: "reply" },
        kind: { literal: "research" },
        // Stable sourceRef: write_artifact dedupes by (tenantId, sourceRef),
        // so a run over an unchanged note set overwrites the same rolling
        // artifact in place instead of piling up duplicates — the "already
        // processed calls are not repeated" / "clean no-op" requirement,
        // expressed through the existing dedupe mechanism rather than a new
        // one (see the module comment above).
        sourceRef: { literal: "granola-call-digest" },
        jobLabel: { literal: label },
      },
      after: ["digest"],
    }),
  },
});
