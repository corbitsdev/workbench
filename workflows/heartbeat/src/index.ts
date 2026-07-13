import { defineWorkflow } from "@intx/workflow";
import type { StepPrimitive } from "@intx/workflow";
import { deterministicToolStep, inlineInferenceStep } from "@workbench/agents";
import {
  HEARTBEAT_BRIEF_SOURCE_FETCH_ARG_MAP,
  heartbeatIntakeStepKey,
  WIRED_BRIEF_SOURCES,
} from "@workbench/shared";
export { heartbeatIntakeStepKey };
import { buildMorningBriefSystemPrompt } from "./prompts";

export const label = "Company Heartbeat";
export const description =
  "On a schedule, pull recent brief-source data (Granola calls today), synthesize a morning brief, mail it to the user, and save it as an artifact.";
export const kind = "heartbeat";

// -------------------------------------------------------------------------
// Workflow definition — gate-free, unattended
//
// Step graph (no awaitSignal anywhere):
//   intake-<source>  deterministicToolStep  one per WIRED_BRIEF_SOURCES entry,
//                     concurrent, input = trigger.payload, nonFatal: true
//   merge-sources     deterministicToolStep  heartbeat_merge_brief_sources
//                      project every intake step → { sources: { … } }
//   brief             inlineInferenceStep    default model
//                      merge(payload, merge-sources content)
//   notify            deterministicToolStep  mail_send   to = userAddress
//   persist           deterministicToolStep  write_artifact  body = brief reply
//
// The intake steps are generated from `WIRED_BRIEF_SOURCES`
// (`@workbench/shared`'s projection of `CREDENTIAL_PROVIDER_CATALOG` entries
// tagged `briefSource.tool`) — adding a source is tagging its catalog entry,
// never editing this file. The generated graph is one concurrent intake per
// `WIRED_BRIEF_SOURCES` entry, then merge-sources → brief (see `index.test.ts`).
//
// v0 reasons over the note summaries each source's list returns (no
// per-note transcript fan-out): a `map` over `steps.intake-granola.output.notes`
// → granola_get_note would deepen the brief, but the serial-chain scheduler
// race (see last30days) makes a single-shot list the safe starting point.
//
// The source / mail / artifact credentials go NOWHERE on this definition: they
// are tool-only providers resolved at tool-execution time by the hub tool
// registry, not inference sources. Declaring them as credentialRequirements
// breaks the sidecar launch ("Source provider <x> is not registered").
// -------------------------------------------------------------------------

function heartbeatIntakeAgentId(sourceKey: string): string {
  return `heartbeat-${heartbeatIntakeStepKey(sourceKey)}`;
}

const intakeStepEntries: [string, StepPrimitive][] = WIRED_BRIEF_SOURCES.map(
  (source) => [
    heartbeatIntakeStepKey(source.key),
    // Pull the source's recent data. Input is the full hub trigger payload
    // (mail identity + brief knobs); argMap narrows to BriefSourceFetchInput
    // so tools never depend on ignoring extra fields. nonFatal: a missing/
    // rejected credential, or the source being disabled, must degrade the
    // brief to a "not available" note (see prompts.ts) rather than fail the
    // whole unattended run.
    deterministicToolStep({
      id: heartbeatIntakeAgentId(source.key),
      title: `Pull ${source.label}`,
      tool: source.tool,
      input: { from: "trigger.payload" },
      argMap: HEARTBEAT_BRIEF_SOURCE_FETCH_ARG_MAP,
      nonFatal: true,
    }),
  ],
);

const intakeStepIds = WIRED_BRIEF_SOURCES.map((source) =>
  heartbeatIntakeStepKey(source.key),
);

export const workflow = defineWorkflow({
  id: kind,
  steps: {
    ...Object.fromEntries(intakeStepEntries),

    // Unwrap each intake envelope under sources.<key> — a flat merge of raw tool
    // results would collide on callId/content/isError and drop all but the last.
    "merge-sources": deterministicToolStep({
      id: "heartbeat-merge-sources",
      title: "Merge brief sources",
      tool: "heartbeat_merge_brief_sources",
      input: {
        project: { from: "steps" },
        fields: intakeStepIds,
      },
      after: intakeStepIds,
    }),

    // Synthesize the brief. Inline single-turn inference on the deploy default
    // model (deepseek-v4-flash) — no per-step model preference declared.
    brief: inlineInferenceStep({
      id: "heartbeat-brief",
      title: "Write the brief",
      systemPrompt: buildMorningBriefSystemPrompt(),
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.merge-sources.output.content" },
        ],
      },
      after: ["merge-sources"],
    }),

    // Deliver the brief to the firing user's `usr_` inbox (T3 resolver).
    notify: deterministicToolStep({
      id: "heartbeat-notify",
      title: "Send the brief",
      tool: "mail_send",
      input: {
        merge: [{ from: "trigger.payload" }, { from: "steps.brief.output" }],
      },
      argMap: {
        to: { from: "userAddress" },
        subject: { literal: "Your morning brief" },
        content: { from: "reply" },
      },
      after: ["brief"],
    }),

    // Persist the brief as a report artifact in the user's workbench.
    persist: deterministicToolStep({
      id: "heartbeat-persist",
      title: "Save the brief",
      tool: "write_artifact",
      input: {
        merge: [{ from: "trigger.payload" }, { from: "steps.brief.output" }],
      },
      argMap: {
        title: { literal: "Morning Brief" },
        body: { from: "reply" },
        kind: { literal: "report" },
        jobLabel: { literal: "Morning Brief" },
      },
      after: ["brief"],
    }),
  },
});
