import { action, awaitSignal, defineWorkflow, map } from "@intx/workflow";
import {
  canonicalizeStepToolName,
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

// Native `action` handler refs — the tool's canonical (factory-prefixed) name,
// resolved via the same build-time-checked lookup `deterministicToolStep`
// uses, so a typo'd or manifest-drifted tool name fails the build instead of
// deploying a step nothing can dispatch.
export const TECH_STACK_HANDLER = canonicalizeStepToolName(
  "sumble-account-intel-tech-stack",
  "sumble_get_org_tech_stack",
);
export const DOCUMENT_HANDLER = canonicalizeStepToolName(
  "sumble-account-intel-document",
  "sumble_account_intel_format_report_document",
);
export const PACKAGE_ARTIFACT_HANDLER = canonicalizeStepToolName(
  "sumble-account-intel-package",
  "write_artifact",
);

// One X search per contact enriches the LinkedIn-only people Sumble returns with
// an X handle. Best-effort: a dead xAI call for one contact must not fail the run.
//
// NOT migrated to a native `action` — two independent blockers, either one
// sufficient on its own (mirrors pain-point-collateral's `persistStep`):
//   1. Field rename: `x_search` requires `query`, but the map item (a Sumble
//      contact) carries the same value under `name`. The native selector
//      vocabulary (`from`/`project`/`merge`/`literal`) can only pick fields
//      through, never rename one.
//   2. `MapPrimitive.step` is typed `StepPrimitive`, not `Primitive` — an
//      `action` cannot be a map's inner step at all (see
//      `interchange/packages/workflow/src/definition/primitives.ts`).
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
    //
    // NOT migrated to a native `action` — `sumble_resolve_organization`'s only
    // matching argument is `identifier`, but the intake field carries the
    // value under `organizationDomain` (the required, user-facing trigger
    // field declared above, matching `SumbleIntakePayloadSchema` in
    // `@workbench/shared`). The native selector vocabulary can pick a field
    // through unrenamed but has no rename shape, so this reshape needs the
    // argMap escape hatch.
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
    //
    // NOT migrated to a native `action` — `sumble_list_teams` requires
    // `organizationSlug`, but the resolved org's own field is `slug`; no
    // selector shape can rename it (same blocker as `resolve`).
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

    // 4. List the org's open jobs (org shape, part 2). Same rename blocker as
    // `teams` — `sumble_list_jobs` also requires `organizationSlug`.
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

    // 5. Pull the org's technology stack (keyed on the resolved slug). Native
    // `action`: `sumble_get_org_tech_stack`'s arg is named `slug` — the SAME
    // name the resolved org record already uses — so no rename is needed.
    // `project` narrows to just `slug` (dropping `name`/`url`/`industry`/
    // `employee_count`) so the org's display name never collides with the
    // tool's own `name` filter argument, matching the original argMap's
    // narrower `{ slug, limit }` shape exactly.
    techStack: action({
      handler: TECH_STACK_HANDLER,
      input: {
        merge: [
          {
            project: { from: "steps.resolve.output.content" },
            fields: ["slug"],
          },
          { literal: { limit: 25 } },
        ],
      },
      effect: { requires: [TECH_STACK_HANDLER] },
      after: ["jobs"],
    }),

    // 6. Find people at the org. Load-bearing (the enrichment map iterates this
    //    step's structured `people` array) — NOT non-fatal, so a failed people
    //    lookup stops the run rather than feeding the map a non-array. Same
    //    organizationSlug-from-slug rename blocker as `teams`/`jobs`.
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

    // 7. Pull buying/intent signals for the org. Same rename blocker.
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
    //    Emits strict JSON containing the brief content, a contacts CSV, and
    //    a Slack-ready draft so the package step can persist all three.
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
    // field is read, so persist never reshapes it. Native `action`:
    // `sumble_account_intel_format_report_document` requires exactly
    // `organizationDomain` and `reply`, both already top-level fields on
    // `steps.intake.output` and `steps.synthesize.output` respectively — the
    // merge passes them through unrenamed, matching this step's original
    // (argMap-less) verbatim-input behavior exactly.
    document: action({
      handler: DOCUMENT_HANDLER,
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.synthesize.output" },
        ],
      },
      effect: { requires: [DOCUMENT_HANDLER] },
      after: ["synthesize"],
    }),

    // 12. Persist the brief as a research artifact. `body` carries the full
    // synthesized brief (summary + contacts CSV + Slack draft); write_artifact's
    // optional structured `content` field is omitted — the synthesize step
    // emits a single `reply`, not a separate Report object, so mapping a
    // `content` field would fail the reshape. `document` already emits
    // write_artifact's title/body verbatim, so `literal` supplies the two
    // remaining constants (`kind`, `jobLabel`). Native `action`: `merge`
    // layers the literal over `document`'s and `review`'s pass-through
    // fields — write_artifact ignores the extra `approved`/`pushToAttio`
    // fields it does not declare, exactly as the original argMap's implicit
    // drop of them did.
    packageArtifact: action({
      handler: PACKAGE_ARTIFACT_HANDLER,
      input: {
        merge: [
          { from: "steps.document.output.content" },
          { from: "steps.review.output" },
          { literal: { kind: "research", jobLabel: "Sumble account intel" } },
        ],
      },
      effect: { requires: [PACKAGE_ARTIFACT_HANDLER] },
      after: ["document", "review"],
    }),
  },
});
