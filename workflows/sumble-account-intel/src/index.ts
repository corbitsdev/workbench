import { action, awaitSignal, defineWorkflow } from "@intx/workflow";
import {
  canonicalizeStepToolName,
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
// resolved via `canonicalizeStepToolName`'s build-time-checked lookup, so
// a typo'd or manifest-drifted tool name fails the build instead of
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

// Native `action` handler refs for this workflow's own tolerant/renamed
// wrappers (see tools.ts) around the underlying Sumble + X tools. Each
// wrapper names its own input fields to match the field the upstream step
// already exposes (`organizationDomain`, `slug`, `people`), so no step here
// needs the argMap escape hatch at all.
export const RESOLVE_ORGANIZATION_HANDLER = canonicalizeStepToolName(
  "sumble-account-intel-resolve",
  "sumble_account_intel_resolve_organization",
);
export const SEARCH_PEOPLE_HANDLER = canonicalizeStepToolName(
  "sumble-account-intel-contacts",
  "sumble_account_intel_search_people",
);
export const LIST_TEAMS_HANDLER = canonicalizeStepToolName(
  "sumble-account-intel-teams",
  "sumble_account_intel_list_teams",
);
export const LIST_JOBS_HANDLER = canonicalizeStepToolName(
  "sumble-account-intel-jobs",
  "sumble_account_intel_list_jobs",
);
export const SEARCH_SIGNALS_HANDLER = canonicalizeStepToolName(
  "sumble-account-intel-signals",
  "sumble_account_intel_search_signals",
);
export const ENRICH_CONTACTS_HANDLER = canonicalizeStepToolName(
  "sumble-account-intel-enrich-social",
  "sumble_account_intel_enrich_contacts",
);

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // 1. Human names the account to research.
    intake: awaitSignal({ name: "intake" }),

    // 2. Resolve the account to a Sumble organization (domain or slug).
    // Native `action`, fatal: the workflow-owned wrapper's own arg is named
    // `organizationDomain` (the intake field's own name), so `input` passes
    // the whole intake output through verbatim — no rename, no argMap. The
    // wrapper still calls the underlying `sumble_resolve_organization` with
    // `identifier`, but that rename now happens in TypeScript inside the
    // tool, not in the step's selector.
    resolve: action({
      handler: RESOLVE_ORGANIZATION_HANDLER,
      input: { from: "steps.intake.output" },
      effect: { requires: [RESOLVE_ORGANIZATION_HANDLER] },
      after: ["intake"],
    }),

    // 3. List the org's teams (org shape, part 1). Downstream steps read the
    //    RESOLVED org record (structured content), keyed on its slug.
    //
    // Native `action`, best-effort: the wrapper's own arg is named `slug`
    // (matching the resolved org's own field, no rename needed at the step
    // level) and never propagates a tool failure as `isError` — see tools.ts.
    teams: action({
      handler: LIST_TEAMS_HANDLER,
      input: {
        merge: [
          {
            project: { from: "steps.resolve.output.content" },
            fields: ["slug"],
          },
          { literal: { limit: 25 } },
        ],
      },
      effect: { requires: [LIST_TEAMS_HANDLER] },
      after: ["resolve"],
    }),

    // 4. List the org's open jobs (org shape, part 2). Same shape as `teams`.
    jobs: action({
      handler: LIST_JOBS_HANDLER,
      input: {
        merge: [
          {
            project: { from: "steps.resolve.output.content" },
            fields: ["slug"],
          },
          { literal: { limit: 25 } },
        ],
      },
      effect: { requires: [LIST_JOBS_HANDLER] },
      after: ["teams"],
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

    // 6. Find people at the org. Load-bearing (the enrichment step iterates
    //    this step's structured `people` array) — the wrapper passes the
    //    underlying tool's `isError` straight through (see tools.ts), so a
    //    failed lookup still fails the run rather than feeding the
    //    enrichment step a non-array.
    contacts: action({
      handler: SEARCH_PEOPLE_HANDLER,
      input: {
        merge: [
          {
            project: { from: "steps.resolve.output.content" },
            fields: ["slug"],
          },
          { literal: { limit: 10 } },
        ],
      },
      effect: { requires: [SEARCH_PEOPLE_HANDLER] },
      after: ["techStack"],
    }),

    // 7. Pull buying/intent signals for the org. Same best-effort shape as
    // `teams`/`jobs`.
    signals: action({
      handler: SEARCH_SIGNALS_HANDLER,
      input: {
        merge: [
          {
            project: { from: "steps.resolve.output.content" },
            fields: ["slug"],
          },
          { literal: { limit: 25 } },
        ],
      },
      effect: { requires: [SEARCH_SIGNALS_HANDLER] },
      after: ["contacts"],
    }),

    // 8. Enrich each contact with an X search (Sumble gives LinkedIn only).
    // Native `action`: the former `map` over a per-contact `x_search` step
    // is gone — `sumble_account_intel_enrich_contacts` iterates the
    // `people` array INTERNALLY (mirroring `granola_spawn_call_runs`'s
    // in-tool fan-out), because `MapPrimitive.step` is typed `StepPrimitive`
    // (not the `Primitive` union `action` belongs to) and the deploy
    // capability walk only reads `primitive.step.agent` for a map node — an
    // `action` cannot be a map's inner step at all. Folding the loop into
    // the tool also drops the `x_search`-vs-contact `query`/`name` rename:
    // the wrapper's own input field is `people`, matching the contacts
    // step's own structured content shape verbatim.
    enrichSocial: action({
      handler: ENRICH_CONTACTS_HANDLER,
      input: { from: "steps.contacts.output.content" },
      effect: { requires: [ENRICH_CONTACTS_HANDLER] },
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
