import { defineAgent } from "@intx/agent";
import { awaitSignal, defineWorkflow, step } from "@intx/workflow";
import {
  DAILY_LINKEDIN_FROM_LOCAL,
  LINKEDIN_DAILY_DRAFT_KIND,
  STORY_BUCKET_ARTIFACT_KIND,
} from "@workbench/linkedin";

export const label = "Daily LinkedIn";
export const description =
  "On a schedule, read the latest story-bucket evidence and draft one LinkedIn post for each recipient picked when the schedule was created, then deliver the drafts via inbox_deliver_batch (idempotent artifacts + mailbox) — no mid-run human gates and no auto-post.";
export const kind = "daily-linkedin";

export {
  DAILY_LINKEDIN_FROM_LOCAL,
  LINKEDIN_DAILY_DRAFT_KIND,
  STORY_BUCKET_ARTIFACT_KIND,
  buildDailyLinkedInBatch,
  dailyDraftSourceRef,
  dailyMailMessageKey,
  mailboxAddressForMember,
  utcDayString,
} from "@workbench/linkedin";

// Tag shared with every step class, naming the step in the catalog/run-UI
// preview in place of the humanized step-map key.
const STEP_TITLE_TAG = "workbench.title";

// Corbits terminology guidance the drafting step's system prompt carries, so
// drafts spell Corbits/Corbits.dev/Interchange/Faremeter consistently
// regardless of how the story bucket spelled them.
const CORBITS_VOCABULARY =
  "Treat Corbits, Corbits.dev, Interchange, and Faremeter as canonical Corbits names; spell them exactly. When source material contains a clear speech-to-text or spelling variant, use the canonical spelling in your output. Do not replace an ambiguous term unless surrounding context identifies it.";

// The tenant-resolved inference source, and the heavier model the drafting step
// opts into — writing publishable prose per person is editorial judgment.
const LLM_CREDENTIAL_NAME = "opencode-zen";
const LLM_PROVIDER = "openai-compatible";
const LLM_WRITER_MODEL = "kimi-k2.6";

/**
 * Capability refs, hardcoded literally.
 *
 * The two `@workbench/tools-artifact` reads carry their canonical
 * `<factoryId>:<bareName>` names, checked against the committed tool manifest by
 * `packages/tool-manifest/src/resolvable-handlers.test.ts`.
 * `inbox_deliver_batch` is a hub-backed tool with no `@workbench/tools-*`
 * manifest row (it lives in `HUB_BACKED_TOOLS` and
 * `HUB_ONLY_TOOL_SIDE_EFFECTS`), so it carries no factory id and stays bare —
 * exactly what `canonicalizeToolNames` would have produced, without this package
 * depending on monorepo-generated data.
 *
 * There is deliberately no roster-lookup capability: who receives a draft is
 * decided when the schedule is created and stored in the trigger payload
 * (CL-4429), so the agent reads people rather than discovering them.
 */
export const INBOX_DELIVER_BATCH_CAPABILITY = "inbox_deliver_batch";
export const ARTIFACT_LIST_CAPABILITY =
  "@workbench/tools-artifact/artifact:artifact_list";
export const ARTIFACT_READ_CAPABILITY =
  "@workbench/tools-artifact/artifact:artifact_read";

/**
 * Agent capabilities: evidence read, then ONE generic inbox batch deliver. `write_artifact` / `mail_send` are intentionally absent — an
 * N-recipient fan-out must not live on the LLM path (mail-guard turn caps, and
 * a re-run with no idempotency key would re-spam every inbox).
 */
const GENERATE_CAPABILITIES = [
  ARTIFACT_LIST_CAPABILITY,
  ARTIFACT_READ_CAPABILITY,
  INBOX_DELIVER_BATCH_CAPABILITY,
] as const;

/**
 * Schedule-field metadata for Routines. `recipients` is a `select-multi` pick
 * over the workbench's members, stored as `SelectedPerson`
 * (`{ refId, displayName }`) pairs on the schedule (CL-4429) — `refId` is the
 * BARE user id, never a `prn_` principal id, and no run-time roster resolution
 * happens at all. The `select-multi` control always sources people from the
 * membership-gated `GET /members`, so it declares no `optionsSource`. An empty
 * selection means nobody, so the field is required; the payload validates
 * against `DailyLinkedInIntakePayloadSchema` at the `/resume` boundary.
 *
 * `userAddress` / `userRefId` / `userDisplayName` are deliberately NOT schedule
 * fields — they are the firing member's identity, stamped onto every fire by
 * this kind's registered trigger-payload enricher
 * (`apps/hub/src/workflow-executor/trigger-payload-enrichment-registry.ts`).
 */
export const INTAKE_FIELDS = [
  {
    name: "recipients",
    label: "Recipients",
    inputHint: "select-multi" as const,
    required: true,
    help: "Who gets a draft each run. Picked once here; edit the schedule to add or remove someone.",
    order: 0,
  },
] as const;

const GENERATE_SYSTEM_PROMPT = `You run the unattended Daily LinkedIn job for a GTM team.

## Input
You receive the run's trigger payload. Fields you care about:
- recipients (array, REQUIRED) — the people this schedule writes for, each { refId, displayName }. This list was chosen when the schedule was created. Use it exactly as given: do not add, drop, reorder, or invent anyone, and never guess a refId.
- userAddress (string) — the firing member's workbench mailbox, e.g. usr_<ref>@<domain>, stamped by the hub on every fire. Pass it unchanged to inbox_deliver_batch.
- userRefId / userDisplayName — firing member identity.

Let day = today's UTC date as YYYY-MM-DD.

## Algorithm (follow in order)

1. **Story evidence** — call artifact_list with kind "${STORY_BUCKET_ARTIFACT_KIND}" and limit 5.
   - If any rows return, artifact_read the most recent (first list item) for body context.
   - If the list is empty or reads fail: continue with empty evidence. Do NOT fail the run. Drafts must note that the story bucket was empty and stay conservative (no invented news).

2. **Draft prose** for every entry in recipients (in memory — do not call write tools yet).
   Style: hook in first two lines; one clear insight; close with a reflective question (not a hard CTA); ~120–220 words; no buzzwords; no em dashes; sentence case; public-safe (no customer-identifying details). Use displayName for voice framing only — do not invent personal facts. Prefer real story-bucket claims; degrade honestly when evidence is thin.

3. **Deliver once** — call inbox_deliver_batch exactly once with:
   - fromLocalPart: "${DAILY_LINKEDIN_FROM_LOCAL}"
   - userAddress: the userAddress from the trigger payload
   - deliveries: one entry per recipient:
     {
       refId: recipient.refId,
       subject: "LinkedIn draft — {displayName} ({day})",
       body: <full draft markdown>,
       messageKey: "linkedin-daily-mail:{recipient.refId}:{day}",
       artifact: {
         title: "LinkedIn draft — {displayName} ({day})",
         body: <same draft>,
         kind: "${LINKEDIN_DAILY_DRAFT_KIND}",
         sourceRef: "linkedin-daily:{recipient.refId}:{day}",
         jobLabel: "daily-linkedin"
       }
     }
   Keys must match exactly (the server rejects an empty messageKey or sourceRef; the same keys make a same-day re-run update the artifact and skip re-mail). Do not call write_artifact or mail_send.

4. **Final reply** (no more tool calls): a short markdown summary built from the deliver result.
   - The result has three lists: delivered, skipped, and errors.
   - **You MUST report every entry in skipped and errors by name, with its reason.** A skipped recipient is someone the schedule still lists but who is no longer a member of this tenant — their drafts are silently going nowhere until someone edits the schedule. Say so plainly; do not bury it, summarize it away, or omit it because the run "mostly worked".
   - If the result is instead an object shaped { "isError": true, "error": ... }, the whole deliver call failed: report that error verbatim and state that nobody received a draft.
   - No JSON in your reply.

## Rules
- No mid-run human selection or review gates — you finish unattended.
- Never auto-post to LinkedIn or any external network.
- Never invent, look up, or hard-code a recipient; the trigger payload's recipients list is the only source of people.
- Call inbox_deliver_batch at most once per run.`;

const generateAgent = defineAgent({
  id: "daily-linkedin-generate",
  description:
    "Reads story-bucket evidence, drafts a LinkedIn post per scheduled recipient, and delivers via inbox_deliver_batch.",
  systemPrompt: [CORBITS_VOCABULARY, GENERATE_SYSTEM_PROMPT].join("\n\n"),
  tools: [],
  capabilities: [...GENERATE_CAPABILITIES],
  inference: {
    sources: [{ provider: LLM_PROVIDER, model: LLM_WRITER_MODEL }],
  },
  tags: {
    credentialName: LLM_CREDENTIAL_NAME,
    [STEP_TITLE_TAG]: "Draft and deliver LinkedIn posts",
  },
});

export const workflow = defineWorkflow({
  id: kind,
  steps: {
    // Unattended: the schedule supplies intake; no mid-run HITL after this.
    intake: awaitSignal({ name: "intake" }),

    // Reads the trigger payload as well as the intake gate's output. The
    // enricher's `userAddress`/`userRefId`/`userDisplayName` ride on
    // `trigger.payload`, while the schedule's stored recipient list arrives
    // through the intake gate — the agent's algorithm needs both, and a single
    // `steps.intake.output` selector would silently drop the identity half,
    // leaving `inbox_deliver_batch`'s required `userAddress` unsatisfiable on
    // every fire.
    generate: step({
      agent: generateAgent,
      input: {
        merge: [{ from: "trigger.payload" }, { from: "steps.intake.output" }],
      },
      after: ["intake"],
    }),
  },
});
