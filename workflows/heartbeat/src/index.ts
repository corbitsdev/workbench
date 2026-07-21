import { defineWorkflow } from "@intx/workflow";
import type { StepPrimitive } from "@intx/workflow";
import { deterministicToolStep, inlineInferenceStep } from "@workbench/agents";
import {
  HEARTBEAT_BRIEF_SOURCE_FETCH_ARG_MAP,
  heartbeatIntakeStepKey,
  morningBriefArtifactKind,
  WIRED_BRIEF_SOURCES,
} from "@workbench/shared";
export { heartbeatIntakeStepKey };
import { buildMorningBriefSystemPrompt } from "./prompts";

export const label = "Company Heartbeat";
export const description =
  "On a schedule, pull recent brief-source data (Granola calls today), synthesize a morning brief, mail it to the user, and save it as an artifact.";
export const kind = "heartbeat";

export { DISPLAY_STEPS } from "./display-steps";

const MORNING_BRIEF_ARTIFACT_KIND = morningBriefArtifactKind();

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
//   persist           deterministicToolStep  write_artifact  body = brief reply (before notify)
//   mail-refs         deterministicToolStep  heartbeat_format_brief_mail_refs
//   notify            deterministicToolStep  mail_send   to = userAddress + artifact refs
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

    // Formats the brief's display name — "<User>'s Morning Brief - DD/MM/YY"
    // — once, shared by both the notify subject and the persisted artifact
    // title (CL-3502). Runs alongside merge-sources/brief; only needs
    // trigger.payload's userDisplayName.
    title: deterministicToolStep({
      id: "heartbeat-title",
      title: "Name the brief",
      tool: "heartbeat_format_brief_title",
      input: { from: "trigger.payload" },
      argMap: {
        userDisplayName: { from: "userDisplayName" },
      },
    }),

    // Persist the brief as a morning-brief artifact in the user's workbench.
    // `kind` is the stable `morning-brief` literal (CL-3503) — never "report"
    // — so the artifact's type never drifts across runs. Runs before notify so
    // mail delivery can depend on the saved artifact (CL-3521).
    persist: deterministicToolStep({
      id: "heartbeat-persist",
      title: "Save the brief",
      tool: "write_artifact",
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.brief.output" },
          { from: "steps.title.output.content" },
        ],
      },
      argMap: {
        title: { from: "title" },
        body: { from: "reply" },
        kind: { literal: MORNING_BRIEF_ARTIFACT_KIND },
        jobLabel: { literal: "Morning Brief" },
      },
      after: ["brief", "title"],
    }),

    // Build mailbox refs from the persisted morning-brief artifact (CL-3521).
    // write_artifact is a stringTool: its step output is
    // `{ content: "{\"artifactId\":...,\"version\":...,\"title\":...}" }`,
    // so artifactId is only reachable via fromJson (same pattern as gamma
    // presentation creator's content envelope).
    "mail-refs": deterministicToolStep({
      id: "heartbeat-mail-refs",
      title: "Link saved brief in mail",
      tool: "heartbeat_format_brief_mail_refs",
      input: {
        merge: [{ from: "trigger.payload" }, { from: "steps.persist.output" }],
      },
      argMap: {
        artifactId: { fromJson: "content", field: "artifactId" },
        runId: { from: "runId" },
        workflowLabel: { literal: label },
      },
      after: ["persist"],
    }),

    // Deliver the brief to the firing user's `usr_` inbox (T3 resolver).
    notify: deterministicToolStep({
      id: "heartbeat-notify",
      title: "Send the brief",
      tool: "mail_send",
      input: {
        merge: [
          { from: "trigger.payload" },
          { from: "steps.brief.output" },
          { from: "steps.title.output.content" },
          { from: "steps.mail-refs.output.content" },
        ],
      },
      argMap: {
        to: { from: "userAddress" },
        subject: { from: "title" },
        content: { from: "reply" },
        refs: { from: "refs" },
      },
      after: ["brief", "title", "persist", "mail-refs"],
    }),
  },
});
