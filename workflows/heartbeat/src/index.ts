import { defineWorkflow } from "@intx/workflow";
import { deterministicToolStep, inlineInferenceStep } from "@workbench/agents";
import { buildMorningBriefSystemPrompt } from "./prompts";

export const label = "Company Heartbeat";
export const description =
  "On a schedule, pull recent Granola calls, synthesize a morning brief, mail it to the user, and save it as an artifact.";
export const kind = "heartbeat";

// Mondays at 13:00 UTC. The T2 scheduler fires the run from this cron; the run's
// `trigger.payload` carries the target user ({ reason, userAddress, userRefId,
// createdAfter? }) resolved by the scheduler, so nothing here is user-specific.
const BRIEF_CRON = "0 13 * * 1";

// -------------------------------------------------------------------------
// Workflow definition — gate-free, unattended
//
// Step graph (no awaitSignal anywhere):
//   intake   deterministicToolStep  granola_list_notes  input = trigger.payload
//   brief    inlineInferenceStep    default model       merge(payload, intake)
//   notify   deterministicToolStep  mail_send           to = userAddress
//   persist  deterministicToolStep  write_artifact      body = brief reply
//
// v0 reasons over the note summaries the list returns (no per-note transcript
// fan-out): a `map` over `steps.intake.output.notes` → granola_get_note would
// deepen the brief, but the serial-chain scheduler race (see last30days) makes
// a single-shot list the safe starting point.
//
// The granola / mail / artifact credentials go NOWHERE on this definition: they
// are tool-only providers resolved at tool-execution time by the hub tool
// registry, not inference sources. Declaring them as credentialRequirements
// breaks the sidecar launch ("Source provider granola is not registered").
// -------------------------------------------------------------------------

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "schedule", cron: BRIEF_CRON },
  steps: {
    // Pull the user's recent calls. The trigger payload is passed verbatim;
    // granola_list_notes reads `createdAfter` from it and ignores the rest.
    intake: deterministicToolStep({
      id: "heartbeat-intake",
      title: "Pull recent calls",
      tool: "granola_list_notes",
      input: { from: "trigger.payload" },
    }),

    // Synthesize the brief. Inline single-turn inference on the deploy default
    // model (deepseek-v4-flash) — no per-step model preference declared.
    brief: inlineInferenceStep({
      id: "heartbeat-brief",
      title: "Write the brief",
      systemPrompt: buildMorningBriefSystemPrompt(),
      input: {
        merge: [{ from: "trigger.payload" }, { from: "steps.intake.output" }],
      },
      after: ["intake"],
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
