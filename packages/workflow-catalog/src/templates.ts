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
 * what they type to reach it; `blockAssetName` is the workflow behind it.
 */
export const WorkbenchTemplateParticipant = type({
  handle: "/^[a-z][a-z0-9-]*$/",
  displayName: "string > 0",
  blockAssetName: "string > 0",
  /** One honest line: what this agent is for. */
  role: "string > 0",
});
export type WorkbenchTemplateParticipant =
  typeof WorkbenchTemplateParticipant.infer;

/**
 * One answer the template cannot supply for the person — the questions
 * the create flow asks before anything runs. `appliesToRoutine` names the
 * routine whose trigger input this fills.
 */
export const WorkbenchTemplateOpenInput = type({
  key: "/^[a-zA-Z][a-zA-Z0-9]*$/",
  label: "string > 0",
  "placeholder?": "string",
  help: "string > 0",
  required: "boolean",
  appliesToRoutine: "/^[a-z][a-z0-9-]*$/",
});
export type WorkbenchTemplateOpenInput =
  typeof WorkbenchTemplateOpenInput.infer;

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

export const WORKBENCH_TEMPLATES: readonly WorkbenchTemplateManifest[] = [
  GTM_TEMPLATE,
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
  const routineKeys = new Set(template.routines.map((routine) => routine.key));
  for (const routine of template.routines) {
    if (!blockNames.has(routine.blockAssetName)) {
      throw new Error(
        `workbench template "${template.id}" routine "${routine.key}" runs "${routine.blockAssetName}", which the template does not install`,
      );
    }
  }
  for (const participant of template.participants) {
    if (!blockNames.has(participant.blockAssetName)) {
      throw new Error(
        `workbench template "${template.id}" participant "${participant.handle}" is backed by "${participant.blockAssetName}", which the template does not install`,
      );
    }
  }
  for (const input of template.openInputs) {
    if (!routineKeys.has(input.appliesToRoutine)) {
      throw new Error(
        `workbench template "${template.id}" input "${input.key}" applies to routine "${input.appliesToRoutine}", which the template does not create`,
      );
    }
  }
}

for (const template of WORKBENCH_TEMPLATES) {
  assertValid(template);
}
