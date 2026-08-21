// Workbench templates: what "pick a kind of workbench" actually creates.
//
// `./index.ts`'s `WORKFLOW_CATALOG` describes ONE workflow at a time —
// what it does, what it needs connected, what its trigger carries. A
// template is the layer above: a named workbench worth having, assembled
// out of several of those workflows, the routines that keep it running,
// the agents a person will talk to in it, and the handful of answers
// only they can give.
//
// Everything here is pure data. Creating a workbench from a template is
// a host concern (`apps/web`'s picker starts the flow); this module is
// the single description both the picker and the creator read, so
// neither hand-types an asset name, a cron, or a connector id.
//
// Blocks are referenced by asset name AND version. A template names the
// exact `workflows/<name>/package.json` version it was designed against,
// so bumping a workflow is a deliberate edit here rather than a silent
// change in what a template creates.

import { type } from "arktype";
// Imported from the package's own `./reviewers` subpath, never its root
// (`@corbits/code-review`) — the root barrel also re-exports the review
// run and GitHub client, which pull in `@corbits/github-tools` and
// `@intx/agent`'s full provider surface. `reviewers.ts` itself has no
// imports at all, so this subpath keeps every consumer of this
// manifest (this package's whole point) off that much heavier graph.
import { CODE_REVIEW_REVIEWERS } from "@corbits/code-review/reviewers";
import {
  SCOUT_AGENT_HANDLE,
  SCOUT_AGENT_DISPLAY_NAME,
  SCOUT_AGENT_DESCRIPTION,
} from "@corbits/scout-agent/definition";
/** One workflow a template installs, pinned to the version it was
 * designed against. `assetName` matches a `WORKFLOW_CATALOG` entry. */
export const WorkbenchTemplateBlock = type({
  assetName: "string > 0",
  version: "/^[0-9]+\\.[0-9]+\\.[0-9]+$/",
});
export type WorkbenchTemplateBlock = typeof WorkbenchTemplateBlock.infer;

/**
 * One routine a template creates on install. `cron` is a 5-field
 * expression in the grammar `@corbits/routines`' `cron.ts` speaks — the
 * authority on whether one is valid and when it fires; the shape check
 * here only catches a malformed literal at module load.
 */
export const WorkbenchTemplateRoutine = type({
  /** Stable key an open input can point at. Unique within a template. */
  key: "/^[a-z][a-z0-9-]*$/",
  /** Which block runs on this schedule. */
  blockAssetName: "string > 0",
  /** What the person sees this routine called. */
  label: "string > 0",
  cron: "/^\\S+ \\S+ \\S+ \\S+ \\S+$/",
  /** One honest line: why this runs on a clock at all. */
  why: "string > 0",
});
export type WorkbenchTemplateRoutine = typeof WorkbenchTemplateRoutine.infer;

/**
 * One agent a person can address in the created workbench. `handle` is
 * what they type to reach it. `blockAssetName` names the workflow behind
 * it when the participant is a lens over one of the template's own
 * blocks (the code-review reviewers); it is absent for a participant
 * that is a standalone chat agent installed straight through the
 * agent-directory create path (Scout, Jimmy) with no block of its own to
 * reference.
 */
export const WorkbenchTemplateParticipant = type({
  handle: "/^[a-z][a-z0-9-]*$/",
  displayName: "string > 0",
  "blockAssetName?": "string > 0",
  /** One honest line: what this agent is for. */
  role: "string > 0",
});
export type WorkbenchTemplateParticipant =
  typeof WorkbenchTemplateParticipant.infer;

/**
 * One workflow a template fires from an inbound webhook rather than a
 * clock — the PR-review trigger a code-review template needs, as opposed
 * to `WorkbenchTemplateRoutine`'s cron-scheduled kind. `triggerFieldKey`
 * names the block's own `WorkflowCatalogEntry.triggerFields` entry the
 * webhook payload fills — see `./index.ts`'s `WorkflowTriggerField`.
 * Creating the live `webhook_trigger` row itself (`@corbits/webhook-triggers`)
 * needs a repo to scope it to, which only exists once the person has
 * answered the template's own open input for it — this is the spec a
 * create flow resolves against that answer, not the row.
 */
export const WorkbenchTemplateWebhookTrigger = type({
  /** Stable key an open input can point at. Unique within a template. */
  key: "/^[a-z][a-z0-9-]*$/",
  /** Which block this webhook launches a run of. */
  blockAssetName: "string > 0",
  /** What the person sees this trigger called. */
  label: "string > 0",
  /** One honest line: why this fires on a webhook instead of a clock. */
  why: "string > 0",
  triggerFieldKey: "/^[a-zA-Z][a-zA-Z0-9]*$/",
});
export type WorkbenchTemplateWebhookTrigger =
  typeof WorkbenchTemplateWebhookTrigger.infer;

/**
 * One answer the template cannot supply for the person — the questions
 * the create flow asks before anything runs. Exactly one of
 * `appliesToRoutine` / `appliesToWebhookTrigger` names the trigger this
 * input's answer feeds: a cron-scheduled routine, or a webhook trigger
 * spec.
 */
export const WorkbenchTemplateOpenInput = type({
  key: "/^[a-zA-Z][a-zA-Z0-9]*$/",
  label: "string > 0",
  "placeholder?": "string",
  help: "string > 0",
  required: "boolean",
  "appliesToRoutine?": "/^[a-z][a-z0-9-]*$/",
  "appliesToWebhookTrigger?": "/^[a-z][a-z0-9-]*$/",
});
export type WorkbenchTemplateOpenInput =
  typeof WorkbenchTemplateOpenInput.infer;

/**
 * The full manifest, as parsed back off a trust boundary — the bench
 * library row a hub seeded (see `@corbits/artifacts-hub`'s template
 * library) travels over HTTP before a picker instantiates from it, so
 * it re-enters through this schema, never through `as`.
 */
export const WorkbenchTemplateManifestSchema = type({
  id: "/^[a-z][a-z0-9-]*$/",
  title: "string > 0",
  promise: "string > 0",
  blocks: WorkbenchTemplateBlock.array(),
  requiredConnections: "string[]",
  optionalConnections: "string[]",
  routines: WorkbenchTemplateRoutine.array(),
  webhookTriggers: WorkbenchTemplateWebhookTrigger.array(),
  participants: WorkbenchTemplateParticipant.array(),
  openInputs: WorkbenchTemplateOpenInput.array(),
});

export type WorkbenchTemplateManifest = {
  readonly id: string;
  /** What the picker row calls it. */
  readonly title: string;
  /** The picker row's one-line promise, in the reader's language. */
  readonly promise: string;
  readonly blocks: readonly WorkbenchTemplateBlock[];
  /**
   * Connector ids (see `@workbench/connections`' `CONNECTOR_REGISTRY` and
   * `MCP_PRESETS`) this template cannot work without, in the order the
   * create flow should ask for them.
   */
  readonly requiredConnections: readonly string[];
  /**
   * Connectors that make the template better but are not a blocker — the
   * create flow offers these, never gates on them.
   */
  readonly optionalConnections: readonly string[];
  readonly routines: readonly WorkbenchTemplateRoutine[];
  /** Webhook-fired triggers this template installs — empty for a
   * clock-only template like GTM. */
  readonly webhookTriggers: readonly WorkbenchTemplateWebhookTrigger[];
  readonly participants: readonly WorkbenchTemplateParticipant[];
  readonly openInputs: readonly WorkbenchTemplateOpenInput[];
};

/**
 * The GTM template (CL-6349): the go-to-market workbench, ported from the
 * OG gtm-workbench's four v1 workflows.
 *
 * The call backbone (granola-call discovering new calls, process-granola-call
 * writing each one up) is what makes the workbench useful on day one, so it
 * is the routine that runs on a clock without anyone asking. The web watch
 * runs on its own weekly clock. The CRM agent and the collateral drafter are
 * on-demand: both start from a specific thing a person points at.
 */
export const GTM_TEMPLATE: WorkbenchTemplateManifest = {
  id: "gtm",
  title: "Go to market",
  promise:
    "Your calls get written up, your CRM tasks get worked, and the web gets watched — you approve anything that leaves the room.",
  blocks: [
    { assetName: "granola-call", version: "0.0.1" },
    { assetName: "process-granola-call", version: "0.0.1" },
    { assetName: "attio-task-agent", version: "0.0.1" },
    { assetName: "exa-topic-watch", version: "0.0.1" },
    { assetName: "pain-point-collateral", version: "0.0.1" },
  ],
  // Attio and Exa are hard requirements: the CRM agent has nothing to
  // work without Attio, and the web watch has nothing to read without
  // Exa. Granola is what the call backbone runs on — the create flow
  // offers it up front, but a workbench with the CRM agent and the web
  // watch alone is still a real workbench, so it never blocks the create.
  requiredConnections: ["attio", "exa"],
  optionalConnections: ["granola"],
  webhookTriggers: [],
  routines: [
    {
      key: "call-discovery",
      blockAssetName: "granola-call",
      label: "Check for new calls",
      cron: "*/30 9-18 * * 1-5",
      why: "Notes are worth most right after the call, so this looks for new ones through the working day rather than once overnight.",
    },
    {
      key: "topic-watch",
      blockAssetName: "exa-topic-watch",
      label: "Watch the web",
      cron: "0 8 * * 1",
      why: "One digest at the start of the week, so a quiet week reads as quiet instead of as five empty runs.",
    },
  ],
  participants: [
    {
      handle: "crm",
      displayName: "CRM task agent",
      blockAssetName: "attio-task-agent",
      role: "Point it at a CRM task and it works the task — reading first, drafting second, and asking before it writes anything back.",
    },
    {
      handle: "collateral",
      displayName: "Pain-point collateral",
      blockAssetName: "pain-point-collateral",
      role: "Give it a call transcript and it drafts a piece aimed at the pain point the customer actually named.",
    },
  ],
  openInputs: [
    {
      key: "topic",
      label: "What should we watch?",
      placeholder: "AI coding agents for go-to-market",
      help: "One topic, as specific as you can make it. The weekly digest covers this and nothing else.",
      required: true,
      appliesToRoutine: "topic-watch",
    },
  ],
};

/**
 * The code-review template (CL-6344): three reviewer lenses over every
 * pull request, plus Myra to talk through what they found. Its blocks
 * install the one `code-review` workflow; the reviewer roster itself is
 * `@corbits/code-review`'s own `CODE_REVIEW_REVIEWERS` — mirrored into
 * participants here rather than duplicated, so a reviewer's handle,
 * name, and one-line role can never drift between the package that
 * runs the review and the template that describes it.
 */
export const CODE_REVIEW_TEMPLATE: WorkbenchTemplateManifest = {
  id: "code-review",
  title: "Code review",
  promise:
    "Three reviewers read every pull request and post what they'd change.",
  blocks: [{ assetName: "code-review", version: "0.0.1" }],
  // GitHub is the one thing this template cannot work without: no
  // repository, no diff to read and nowhere to post the review.
  requiredConnections: ["github"],
  optionalConnections: [],
  routines: [],
  webhookTriggers: [
    {
      key: "pull-request-opened",
      blockAssetName: "code-review",
      label: "Review new pull requests",
      why: "A review is worth most posted while the pull request is still open for comment, so this fires the moment GitHub says one exists rather than waiting on a clock.",
      triggerFieldKey: "pullRequestUrl",
    },
  ],
  participants: [
    {
      handle: "myra",
      displayName: "Myra",
      blockAssetName: "code-review",
      role: "Talks through what the reviewers found and helps you decide what to act on.",
    },
    ...CODE_REVIEW_REVIEWERS.map((reviewer) => ({
      handle: reviewer.handle,
      displayName: reviewer.displayName,
      blockAssetName: "code-review",
      role: reviewer.description,
    })),
  ],
  openInputs: [
    {
      key: "repos",
      label: "Which repositories?",
      placeholder: "corbitsdev/workbench",
      help: "The GitHub repositories to watch. Every new pull request there gets reviewed.",
      required: true,
      appliesToWebhookTrigger: "pull-request-opened",
    },
  ],
};

/**
 * The due-diligence template (CL-6499): Scout for the web/firm-memory
 * research and Myra to talk through what it found. Scout is a
 * standalone chat agent, not a lens over a block workflow — it has no
 * cron, no webhook, nothing to schedule — so it carries no
 * `blockAssetName` and this template's `blocks` list stays empty.
 * Exa (Scout's web-research tool) resolves through the keyless MCP
 * preset, so nothing here blocks the create on a connection.
 */
export const DUE_DILIGENCE_TEMPLATE: WorkbenchTemplateManifest = {
  id: "due-diligence",
  title: "Research & due diligence",
  promise:
    "Scout researches the web and what your team already knows, and saves what it finds so you can pick it up later.",
  blocks: [],
  requiredConnections: [],
  optionalConnections: ["exa"],
  routines: [],
  webhookTriggers: [],
  participants: [
    {
      handle: "myra",
      displayName: "Myra",
      role: "Talks through what Scout found and helps you decide what to do with it.",
    },
    {
      handle: SCOUT_AGENT_HANDLE,
      displayName: SCOUT_AGENT_DISPLAY_NAME,
      role: SCOUT_AGENT_DESCRIPTION,
    },
  ],
  openInputs: [],
};

export const WORKBENCH_TEMPLATES: readonly WorkbenchTemplateManifest[] = [
  GTM_TEMPLATE,
  CODE_REVIEW_TEMPLATE,
  DUE_DILIGENCE_TEMPLATE,
];

const templateById = new Map(
  WORKBENCH_TEMPLATES.map((template) => [template.id, template]),
);

export function workbenchTemplate(
  id: string,
): WorkbenchTemplateManifest | undefined {
  return templateById.get(id);
}

/**
 * Every asset name a template names — its blocks, and the block behind
 * each routine and participant. A caller checking a template against
 * `WORKFLOW_CATALOG` walks this rather than three separate arrays.
 */
export function templateBlockAssetNames(
  template: WorkbenchTemplateManifest,
): readonly string[] {
  return template.blocks.map((block) => block.assetName);
}

/** The exact string a hub seeds into the bench library for one template. */
/** The shipped templates as bench-library seed entries — the ONE
 * serialization every seeder uses (`apps/hub`'s boot seed and the eval
 * harness's scratch-hub seed), so the two can never drift. */
export function workbenchTemplateLibraryEntries(): readonly {
  readonly id: string;
  readonly content: string;
}[] {
  return WORKBENCH_TEMPLATES.map((template) => ({
    id: template.id,
    content: serializeWorkbenchTemplateManifest(template),
  }));
}

export function serializeWorkbenchTemplateManifest(
  template: WorkbenchTemplateManifest,
): string {
  return JSON.stringify(template, null, 2);
}

/**
 * Parses a seeded library row's content back into a manifest, running
 * the same cross-reference checks module load runs on the shipped
 * constants. Throws on anything malformed — an unreadable library row
 * is a seeding defect to surface, never a shape to limp past.
 */
export function parseWorkbenchTemplateManifest(
  data: unknown,
): WorkbenchTemplateManifest {
  const raw = typeof data === "string" ? JSON.parse(data) : data;
  const parsed = WorkbenchTemplateManifestSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `workbench template manifest failed to parse: ${parsed.summary}`,
    );
  }
  assertValid(parsed);
  return parsed;
}

function assertValid(template: WorkbenchTemplateManifest): void {
  const blockNames = new Set(templateBlockAssetNames(template));
  const parsedBlocks = WorkbenchTemplateBlock.array()(template.blocks);
  if (parsedBlocks instanceof type.errors) {
    throw new Error(
      `workbench template "${template.id}" has an invalid blocks shape: ${parsedBlocks.summary}`,
    );
  }
  const parsedRoutines = WorkbenchTemplateRoutine.array()(template.routines);
  if (parsedRoutines instanceof type.errors) {
    throw new Error(
      `workbench template "${template.id}" has an invalid routines shape: ${parsedRoutines.summary}`,
    );
  }
  const parsedParticipants = WorkbenchTemplateParticipant.array()(
    template.participants,
  );
  if (parsedParticipants instanceof type.errors) {
    throw new Error(
      `workbench template "${template.id}" has an invalid participants shape: ${parsedParticipants.summary}`,
    );
  }
  const parsedInputs = WorkbenchTemplateOpenInput.array()(template.openInputs);
  if (parsedInputs instanceof type.errors) {
    throw new Error(
      `workbench template "${template.id}" has an invalid openInputs shape: ${parsedInputs.summary}`,
    );
  }
  const parsedWebhookTriggers = WorkbenchTemplateWebhookTrigger.array()(
    template.webhookTriggers,
  );
  if (parsedWebhookTriggers instanceof type.errors) {
    throw new Error(
      `workbench template "${template.id}" has an invalid webhookTriggers shape: ${parsedWebhookTriggers.summary}`,
    );
  }
  const routineKeys = new Set(template.routines.map((routine) => routine.key));
  for (const routine of template.routines) {
    if (!blockNames.has(routine.blockAssetName)) {
      throw new Error(
        `workbench template "${template.id}" routine "${routine.key}" runs "${routine.blockAssetName}", which the template does not install`,
      );
    }
  }
  const webhookTriggerKeys = new Set(
    template.webhookTriggers.map((trigger) => trigger.key),
  );
  for (const trigger of template.webhookTriggers) {
    if (!blockNames.has(trigger.blockAssetName)) {
      throw new Error(
        `workbench template "${template.id}" webhook trigger "${trigger.key}" fires "${trigger.blockAssetName}", which the template does not install`,
      );
    }
  }
  for (const participant of template.participants) {
    if (
      participant.blockAssetName !== undefined &&
      !blockNames.has(participant.blockAssetName)
    ) {
      throw new Error(
        `workbench template "${template.id}" participant "${participant.handle}" is backed by "${participant.blockAssetName}", which the template does not install`,
      );
    }
  }
  for (const input of template.openInputs) {
    const appliesToCount =
      Number(input.appliesToRoutine !== undefined) +
      Number(input.appliesToWebhookTrigger !== undefined);
    if (appliesToCount !== 1) {
      throw new Error(
        `workbench template "${template.id}" input "${input.key}" must apply to exactly one of a routine or a webhook trigger`,
      );
    }
    if (
      input.appliesToRoutine !== undefined &&
      !routineKeys.has(input.appliesToRoutine)
    ) {
      throw new Error(
        `workbench template "${template.id}" input "${input.key}" applies to routine "${input.appliesToRoutine}", which the template does not create`,
      );
    }
    if (
      input.appliesToWebhookTrigger !== undefined &&
      !webhookTriggerKeys.has(input.appliesToWebhookTrigger)
    ) {
      throw new Error(
        `workbench template "${template.id}" input "${input.key}" applies to webhook trigger "${input.appliesToWebhookTrigger}", which the template does not create`,
      );
    }
  }
}

for (const template of WORKBENCH_TEMPLATES) {
  assertValid(template);
}
