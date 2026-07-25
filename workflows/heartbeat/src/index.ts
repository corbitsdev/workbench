import { action, defineWorkflow } from "@intx/workflow";
import type { ActionPrimitive } from "@intx/workflow";
import { canonicalizeStepToolName, agentStep } from "@workbench/agents";
import {
  heartbeatIntakeStepKey,
  morningBriefArtifactKind,
  WIRED_BRIEF_SOURCES,
} from "@workbench/shared";
export { heartbeatIntakeStepKey };
import { buildMorningBriefSystemPrompt } from "./prompts";

export const label = "Morning brief";
export const description =
  "On a schedule, pull recent brief-source data (Granola calls today), synthesize a morning brief, mail it to the user, and save it as an artifact.";
export const kind = "heartbeat";

export { DISPLAY_STEPS } from "./display-steps";

const MORNING_BRIEF_ARTIFACT_KIND = morningBriefArtifactKind();

// Native `action` handler refs — the tool's canonical (factory-prefixed) name,
// resolved via the same build-time-checked lookup `deterministicToolStep`
// uses, so a typo'd or manifest-drifted tool name fails the build instead of
// deploying a step nothing can dispatch.
export const HEARTBEAT_FORMAT_BRIEF_TITLE_HANDLER = canonicalizeStepToolName(
  "heartbeat-title",
  "heartbeat_format_brief_title",
);
export const HEARTBEAT_MERGE_BRIEF_SOURCES_HANDLER = canonicalizeStepToolName(
  "heartbeat-merge-sources",
  "heartbeat_merge_brief_sources",
);
export const HEARTBEAT_FORMAT_BRIEF_DOCUMENT_HANDLER = canonicalizeStepToolName(
  "heartbeat-document",
  "heartbeat_format_brief_document",
);
export const WRITE_ARTIFACT_HANDLER = canonicalizeStepToolName(
  "heartbeat-persist",
  "write_artifact",
);
export const HEARTBEAT_FORMAT_BRIEF_NOTIFY_HANDLER = canonicalizeStepToolName(
  "heartbeat-notify-prep",
  "heartbeat_format_brief_notify",
);
export const MAIL_SEND_HANDLER = canonicalizeStepToolName(
  "heartbeat-notify",
  "mail_send",
);
export const HEARTBEAT_INTAKE_SOURCE_HANDLER = canonicalizeStepToolName(
  "heartbeat-intake-source",
  "heartbeat_intake_source",
);

// -------------------------------------------------------------------------
// Workflow definition — gate-free, unattended
//
// Step graph (no awaitSignal anywhere):
//   intake-<source>  action  heartbeat_intake_source
//                     one per WIRED_BRIEF_SOURCES entry, concurrent,
//                     input = trigger.payload projected to
//                     { tool, enabledSources, createdAfter } (native primitive)
//   merge-sources     action  heartbeat_merge_brief_sources
//                      project every intake step → { sources: { … } } (native primitive)
//   brief             agentStep    default model
//                      merge(payload, merge-sources content)
//   title             action  heartbeat_format_brief_title (native primitive)
//   document          action  heartbeat_format_brief_document (native primitive)
//                      pairs title.output.content + brief.output.reply into
//                      { title, body } — the one place the agent's `reply`
//                      field is read, so persist/notify never reshape it
//   persist           action  write_artifact  (before notify, native primitive)
//   notify-prep       action  heartbeat_format_brief_notify (native primitive)
//                      builds mail_send's exact { to, subject, content, refs }
//   notify            action  mail_send   verbatim from notify-prep (native primitive)
//
// The intake steps are native `action` steps calling `heartbeat_intake_source`
// (`./intake-tool.ts`, CL-4464) rather than the underlying per-source tool
// (`granola_list_notes` etc.) directly — `ActionPrimitive` has no `nonFatal`
// field at all (`@intx/workflow`'s `primitives.ts`) and a thrown tool error in
// an action's handler propagates through `ctx.perform`
// (`apps/sidecar/src/action-tool-handler.ts`) and fails the run, so a missing/
// rejected source credential or a source-side error must never reach that
// layer as a throw. `heartbeat_intake_source` moves the tolerance INSIDE a
// heartbeat-owned tool instead: it resolves the named source's own credential
// and dispatches through `createToolRunner`, whose documented contract is
// "must not throw" (`interchange/packages/agent/src/tool.ts`) — a missing
// credential or source-side failure comes back as a completed `isError`
// envelope, exactly the shape `mergeHeartbeatBriefSources` (`@workbench/shared`)
// already parses per source, so the brief still degrades to a "not available"
// note (see prompts.ts) with no `nonFatal` needed anywhere in this workflow.
//
// The intake steps are generated from `WIRED_BRIEF_SOURCES`
// (`@workbench/shared`'s projection of `CREDENTIAL_PROVIDER_CATALOG` entries
// tagged `briefSource.tool`) — adding a source is tagging its catalog entry
// and registering its `create*Tools` builder in `intake-tool.ts`'s
// `SOURCE_TOOL_BUILDERS`, never editing this file. The generated graph is one
// concurrent intake per `WIRED_BRIEF_SOURCES` entry, then merge-sources →
// brief (see `index.test.ts`).
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

const intakeStepEntries: [string, ActionPrimitive][] = WIRED_BRIEF_SOURCES.map(
  (source) => [
    heartbeatIntakeStepKey(source.key),
    // Pull the source's recent data via the best-effort wrapper
    // (`heartbeat_intake_source`, `./intake-tool.ts`), never the source's own
    // tool directly — see the step-graph comment above for why. `enabledSources`
    // /`createdAfter` are both stamped unconditionally by
    // `enrichHeartbeatTriggerPayload` (`apps/hub/src/lib/heartbeat-trigger-payload.ts`)
    // on every heartbeat start, so projecting them straight off
    // `trigger.payload` is safe — they are never absent on a real fire.
    action({
      handler: HEARTBEAT_INTAKE_SOURCE_HANDLER,
      input: {
        merge: [
          {
            project: { from: "trigger.payload" },
            fields: ["enabledSources", "createdAfter"],
          },
          { literal: { tool: source.tool } },
        ],
      },
      effect: { requires: [HEARTBEAT_INTAKE_SOURCE_HANDLER] },
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
    "merge-sources": action({
      handler: HEARTBEAT_MERGE_BRIEF_SOURCES_HANDLER,
      input: {
        project: { from: "steps" },
        fields: intakeStepIds,
      },
      effect: { requires: [HEARTBEAT_MERGE_BRIEF_SOURCES_HANDLER] },
      after: intakeStepIds,
    }),

    // Synthesize the brief. Inline single-turn inference on the deploy default
    // model (deepseek-v4-flash) — no per-step model preference declared.
    brief: agentStep({
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
    //
    // Bug fix: the prior `deterministicToolStep` argMap mapped `userDisplayName`
    // with a non-optional `{ from }` — a firing user with no known display
    // name (an agent principal, or an identity-lookup miss — see
    // `HeartbeatMemberIdentity.userDisplayName` in
    // `apps/hub/src/lib/heartbeat-trigger-payload.ts`, which OMITS the key
    // entirely rather than sending it `undefined`) hit "argMap maps tool arg
    // userDisplayName from input field userDisplayName, but that field is
    // absent" and failed the whole run, even though
    // `heartbeat_format_brief_title`'s schema always treats the field as
    // optional and `formatHeartbeatBriefTitle` has a real "Your Morning
    // Brief" fallback for exactly this case. A native `project` selector has
    // no such presence check (it assigns `source[field]`, `undefined` when
    // absent, same as any other optional JS field read) so the fallback path
    // now actually reaches the tool instead of failing first.
    title: action({
      handler: HEARTBEAT_FORMAT_BRIEF_TITLE_HANDLER,
      input: {
        project: { from: "trigger.payload" },
        fields: ["userDisplayName"],
      },
      effect: { requires: [HEARTBEAT_FORMAT_BRIEF_TITLE_HANDLER] },
    }),

    // Pairs the title step's title with the brief agent's reply into the
    // { title, body } document persist and notify-prep both need (CL-4232).
    // This is the ONE place the agent's `reply` output field is read — every
    // downstream deterministic step sees plain `title`/`body` fields, never
    // `reply`.
    document: action({
      handler: HEARTBEAT_FORMAT_BRIEF_DOCUMENT_HANDLER,
      input: {
        merge: [
          { from: "steps.title.output.content" },
          { from: "steps.brief.output" },
        ],
      },
      effect: { requires: [HEARTBEAT_FORMAT_BRIEF_DOCUMENT_HANDLER] },
      after: ["title", "brief"],
    }),

    // Persist the brief as a morning-brief artifact in the user's workbench.
    // `kind` is the stable `morning-brief` literal (CL-3503) — never "report"
    // — so the artifact's type never drifts across runs. Runs before notify so
    // mail delivery can depend on the saved artifact (CL-3521).
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
              kind: MORNING_BRIEF_ARTIFACT_KIND,
              jobLabel: "Morning Brief",
            },
          },
        ],
      },
      effect: { requires: [WRITE_ARTIFACT_HANDLER] },
      after: ["document"],
    }),

    // Builds mail_send's exact { to, subject, content, refs } argument shape
    // from the firing user's address, the brief document, and the persisted
    // artifact id (CL-4232) — write_artifact's `content` carries the
    // { artifactId, version, title } object directly (not stringified), so
    // artifactId is a plain top-level field, no JSON envelope to unwrap.
    "notify-prep": action({
      handler: HEARTBEAT_FORMAT_BRIEF_NOTIFY_HANDLER,
      input: {
        merge: [
          {
            project: {
              merge: [
                { from: "trigger.payload" },
                { from: "steps.document.output.content" },
                { from: "steps.persist.output.content" },
              ],
            },
            fields: ["userAddress", "title", "body", "artifactId", "runId"],
          },
          { literal: { workflowLabel: label } },
        ],
      },
      effect: { requires: [HEARTBEAT_FORMAT_BRIEF_NOTIFY_HANDLER] },
      after: ["document", "persist"],
    }),

    // Deliver the brief to the firing user's `usr_` inbox (T3 resolver).
    // notify-prep already emits mail_send's exact argument names, so this
    // step is a pure passthrough.
    notify: action({
      handler: MAIL_SEND_HANDLER,
      input: { from: "steps.notify-prep.output.content" },
      effect: { requires: [MAIL_SEND_HANDLER] },
      after: ["notify-prep"],
    }),
  },
});
