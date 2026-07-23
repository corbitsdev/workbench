import { awaitSignal, defineWorkflow, map } from "@intx/workflow";
import {
  deterministicToolStep,
  agentStep,
  LLM_WRITER_MODEL,
} from "@workbench/agents";
import { buildAccountIntelSystemPrompt } from "./prompts";

// -------------------------------------------------------------------------
// Workflow metadata
// -------------------------------------------------------------------------

export const label = "Sumble Account Intelligence";
export const description =
  "Research an account across Sumble (org, teams, jobs, tech stack, contacts, signals), enrich contacts on X, and synthesize a reviewable account intelligence brief.";
export const kind = "sumble-account-intel";

export { DISPLAY_STEPS } from "./display-steps";

// Schedule field metadata (CL-3860): organization domain + optional Attio push.
// Multi-gate workflow — opt into scheduled post-intake drive so it is attachable.
export const ALLOWS_SCHEDULED_POST_INTAKE_DRIVE = true;

export const INTAKE_FIELDS = [
  {
    name: "organizationDomain",
    label: "Organization domain",
    kind: "text",
    inputHint: "text",
    required: true,
    placeholder: "acme.com",
    help: "Company domain or Sumble org slug to research.",
    order: 0,
  },
  {
    name: "pushToAttio",
    label: "Push to Attio",
    kind: "boolean",
    inputHint: "boolean",
    required: false,
    help: "When on, write the account brief back to Attio after review.",
    order: 1,
  },
] as const;

// The synthesis turn produces a multi-section brief plus a contacts CSV and a
// Slack-ready draft as strict JSON; without an explicit ceiling the writer source
// can truncate mid-object with a clean finish_reason:"length". 8192 comfortably
// clears the longest brief this workflow warrants.
const SYNTHESIZE_MAX_TOKENS = 8192;

// One X search per contact enriches the LinkedIn-only people Sumble returns with
// an X handle. Best-effort: a dead xAI call for one contact must not fail the run.
const enrichSocialStep = deterministicToolStep({
  id: "sumble-account-intel-enrich-social",
  title: "Find the contact on X",
  tool: "x_search",
  // The map passes each contact object as `trigger.payload`; the argMap pulls the
  // contact's name as the X query and caps the result set.
  input: { from: "trigger.payload" },
  argMap: {
    query: { from: "name" },
    limit: { literal: 5 },
  },
  nonFatal: true,
});

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // 1. Human names the account to research.
    intake: awaitSignal({ name: "intake" }),

    // 2. Resolve the account to a Sumble organization (domain or slug).
    resolve: deterministicToolStep({
      id: "sumble-account-intel-resolve",
      title: "Resolve the organization",
      tool: "sumble_resolve_organization",
      input: { from: "steps.intake.output" },
      // One intake field carries a domain OR a slug; the tool classifies it by
      // shape and routes it to the right Sumble org-ref field.
      argMap: {
        identifier: { from: "organizationDomain" },
      },
      after: ["intake"],
    }),

    // 3. List the org's teams (org shape, part 1). Downstream steps read the
    //    RESOLVED org record (structured content), keyed on its slug.
    teams: deterministicToolStep({
      id: "sumble-account-intel-teams",
      title: "List the teams",
      tool: "sumble_list_teams",
      input: { from: "steps.resolve.output.content" },
      argMap: {
        organizationSlug: { from: "slug" },
        limit: { literal: 25 },
      },
      after: ["resolve"],
      nonFatal: true,
    }),

    // 4. List the org's open jobs (org shape, part 2).
    jobs: deterministicToolStep({
      id: "sumble-account-intel-jobs",
      title: "List the open jobs",
      tool: "sumble_list_jobs",
      input: { from: "steps.resolve.output.content" },
      argMap: {
        organizationSlug: { from: "slug" },
        limit: { literal: 25 },
      },
      after: ["teams"],
      nonFatal: true,
    }),

    // 5. Pull the org's technology stack (keyed on the resolved slug).
    techStack: deterministicToolStep({
      id: "sumble-account-intel-tech-stack",
      title: "Read the tech stack",
      tool: "sumble_get_org_tech_stack",
      input: { from: "steps.resolve.output.content" },
      argMap: {
        slug: { from: "slug" },
        limit: { literal: 25 },
      },
      after: ["jobs"],
      nonFatal: true,
    }),

    // 6. Find people at the org. Load-bearing (the enrichment map iterates this
    //    step's structured `people` array) — NOT non-fatal, so a failed people
    //    lookup stops the run rather than feeding the map a non-array.
    contacts: deterministicToolStep({
      id: "sumble-account-intel-contacts",
      title: "Find the contacts",
      tool: "sumble_search_people",
      input: { from: "steps.resolve.output.content" },
      argMap: {
        organizationSlug: { from: "slug" },
        limit: { literal: 10 },
      },
      after: ["techStack"],
    }),

    // 7. Pull buying/intent signals for the org.
    signals: deterministicToolStep({
      id: "sumble-account-intel-signals",
      title: "Scan the buying signals",
      tool: "sumble_search_signals",
      input: { from: "steps.resolve.output.content" },
      argMap: {
        organizationSlug: { from: "slug" },
        limit: { literal: 25 },
      },
      after: ["contacts"],
      nonFatal: true,
    }),

    // 8. Enrich each contact with an X search (Sumble gives LinkedIn only).
    //    Iterates the structured `people` array the contacts step exposes.
    enrichSocial: map({
      over: { from: "steps.contacts.output.content.people" },
      step: enrichSocialStep,
      after: ["signals"],
    }),

    // 9. Synthesize the account intelligence brief from every upstream step.
    //    Emits strict JSON containing the brief content, a contacts CSV string,
    //    and a Slack-ready draft so the package step can persist all three.
    synthesize: agentStep({
      id: "sumble-account-intel-synthesize",
      title: "Write the account brief",
      systemPrompt: buildAccountIntelSystemPrompt(),
      model: LLM_WRITER_MODEL,
      maxTokens: SYNTHESIZE_MAX_TOKENS,
      input: { from: "steps" },
      after: ["enrichSocial"],
    }),

    // 10. Human reviews and approves the brief before it is persisted.
    review: awaitSignal({ name: "review", after: ["synthesize"] }),

    // 11. Pairs the organization domain with the synthesize agent's reply into
    // { title, body } (CL-4232) — the one place the agent's `reply` output
    // field is read, so persist never reshapes it.
    document: deterministicToolStep({
      id: "sumble-account-intel-document",
      title: "Compose the account brief document",
      tool: "sumble_account_intel_format_report_document",
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.synthesize.output" },
        ],
      },
      after: ["synthesize"],
    }),

    // 12. Persist the brief as a research artifact. `body` carries the full
    // synthesized brief (summary + contacts CSV + Slack draft); write_artifact's
    // optional structured `content` field is omitted — the synthesize step
    // emits a single `reply`, not a separate Report object, so mapping a
    // `content` field would fail the reshape. document already emits
    // write_artifact's title/body verbatim, so only the two literals remain.
    packageArtifact: deterministicToolStep({
      id: "sumble-account-intel-package",
      title: "Save the account brief",
      tool: "write_artifact",
      input: {
        merge: [
          { from: "steps.document.output.content" },
          { from: "steps.review.output" },
        ],
      },
      argMap: {
        title: { from: "title" },
        body: { from: "body" },
        kind: { literal: "research" },
        jobLabel: { literal: "Sumble account intel" },
      },
      after: ["document", "review"],
    }),
  },
});
