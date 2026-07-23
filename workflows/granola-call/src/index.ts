import { defineWorkflow } from "@intx/workflow";
import { deterministicToolStep, agentStep } from "@workbench/agents";
import { GRANOLA_CALL_ANALYSIS_SYSTEM_PROMPT } from "./prompts";

export const label = "Granola Call Processing";
export const description =
  "Process one Granola call: classify internal vs external, analyze with a single agent step, persist typed artifacts, create tasks, and fan out mail.";
export const kind = "granola-call";

export { DISPLAY_STEPS } from "./display-steps";

// -------------------------------------------------------------------------
// Workflow definition — deterministic steps + one agentStep
//
// Step graph:
//   fetch           granola_get_note (credentialed)
//   normalize       granola_normalize_note
//   classify        granola_classify_call  (merge trigger + normalize)
//   build-prompt    granola_build_analysis_prompt
//   analyze         agentStep             ← the only agent step
//   parse           granola_parse_analysis
//   prepare         granola_prepare_artifacts  (merge normalize+parse+classify)
//   persist-pain    write_artifact
//   persist-summary write_artifact
//   persist-brief   write_artifact
//   create-tasks    granola_create_tasks
//   fanout          granola_fanout_call
//   emit            granola_emit_run_outputs
//
// Trigger payload: { noteId: string, tenantDomain?: string }
// Missing tenantDomain classifies as "unknown" (never skips the step).
// -------------------------------------------------------------------------

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    fetch: deterministicToolStep({
      id: "granola-call-fetch",
      title: "Fetch note",
      tool: "granola_get_note",
      input: { from: "trigger.payload" },
      argMap: {
        noteId: { from: "noteId" },
      },
    }),

    normalize: deterministicToolStep({
      id: "granola-call-normalize",
      title: "Normalize",
      tool: "granola_normalize_note",
      input: { from: "steps.fetch.output" },
      after: ["fetch"],
    }),

    classify: deterministicToolStep({
      id: "granola-call-classify",
      title: "Classify",
      tool: "granola_classify_call",
      // Merge note (participants) with trigger payload (tenantDomain).
      // Do NOT mark tenantDomain optional — reshapeWithArgMap would skip the
      // entire tool call when the field is missing. The tool treats empty
      // domain as classification "unknown".
      input: {
        merge: [
          { from: "steps.normalize.output" },
          { from: "trigger.payload" },
        ],
      },
      argMap: {
        note: { from: "content" },
        tenantDomain: { from: "tenantDomain" },
      },
      after: ["normalize"],
    }),

    "build-prompt": deterministicToolStep({
      id: "granola-call-build-prompt",
      title: "Build analysis prompt",
      tool: "granola_build_analysis_prompt",
      input: { from: "steps.normalize.output" },
      after: ["normalize"],
    }),

    // Single agent step for the whole workflow (CL-3647).
    analyze: agentStep({
      id: "granola-call-analyze",
      title: "Analyze",
      systemPrompt: GRANOLA_CALL_ANALYSIS_SYSTEM_PROMPT,
      // Prefer the formatted analysis message; fall back to envelope content.
      input: { from: "steps.build-prompt.output" },
      after: ["build-prompt"],
    }),

    parse: deterministicToolStep({
      id: "granola-call-parse",
      title: "Parse analysis",
      tool: "granola_parse_analysis",
      input: { from: "steps.analyze.output" },
      after: ["analyze"],
    }),

    prepare: deterministicToolStep({
      id: "granola-call-prepare",
      title: "Prepare artifacts",
      tool: "granola_prepare_artifacts",
      input: {
        project: { from: "steps" },
        fields: ["normalize", "parse", "classify"],
      },
      after: ["normalize", "parse", "classify"],
    }),

    "persist-pain": deterministicToolStep({
      id: "granola-call-persist-pain",
      title: "Persist pain points",
      tool: "write_artifact",
      input: { from: "steps.prepare.output" },
      argMap: {
        title: { from: "painTitle" },
        kind: { from: "painKind" },
        body: { from: "painContent" },
        sourceRef: { from: "painSourceRef" },
      },
      after: ["prepare"],
    }),

    "persist-summary": deterministicToolStep({
      id: "granola-call-persist-summary",
      title: "Persist summary",
      tool: "write_artifact",
      input: { from: "steps.prepare.output" },
      argMap: {
        title: { from: "summaryTitle" },
        kind: { from: "summaryKind" },
        body: { from: "summaryContent" },
        sourceRef: { from: "summarySourceRef" },
      },
      after: ["prepare"],
    }),

    "persist-brief": deterministicToolStep({
      id: "granola-call-persist-brief",
      title: "Persist brief",
      tool: "write_artifact",
      input: { from: "steps.prepare.output" },
      argMap: {
        title: { from: "briefTitle" },
        kind: { from: "briefKind" },
        body: { from: "briefContent" },
        sourceRef: { from: "briefSourceRef" },
      },
      after: ["prepare"],
    }),

    "create-tasks": deterministicToolStep({
      id: "granola-call-create-tasks",
      title: "Create tasks",
      tool: "granola_create_tasks",
      // Project step envelopes; pure tool peels content so fields never clobber.
      // Include parse so analysis is available even if prepare shape drifts.
      input: {
        project: { from: "steps" },
        fields: [
          "parse",
          "prepare",
          "persist-pain",
          "persist-summary",
          "persist-brief",
        ],
      },
      after: [
        "parse",
        "prepare",
        "persist-pain",
        "persist-summary",
        "persist-brief",
      ],
    }),

    fanout: deterministicToolStep({
      id: "granola-call-fanout",
      title: "Fan out",
      tool: "granola_fanout_call",
      input: {
        project: { from: "steps" },
        fields: [
          "prepare",
          "create-tasks",
          "persist-pain",
          "persist-summary",
          "persist-brief",
        ],
      },
      after: [
        "prepare",
        "create-tasks",
        "persist-pain",
        "persist-summary",
        "persist-brief",
      ],
    }),

    emit: deterministicToolStep({
      id: "granola-call-emit",
      title: "Emit outputs",
      tool: "granola_emit_run_outputs",
      // Project step envelopes; emit peels content so all three artifact ids survive.
      input: {
        project: { from: "steps" },
        fields: ["prepare", "persist-pain", "persist-summary", "persist-brief"],
      },
      after: [
        "prepare",
        "persist-pain",
        "persist-summary",
        "persist-brief",
        "create-tasks",
        "fanout",
      ],
    }),
  },
});
