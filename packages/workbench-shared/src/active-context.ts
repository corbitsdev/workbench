import { type } from "arktype";

// The active-context projector (CL-2495). Everywhere a user navigates in the
// Workbench there is an entity-bound surface — an open artifact, an open
// workflow run, or a chat thread. This module turns that surface into a
// compact, token-bounded projection that can be attached to a Myra message.
//
// The projection is emitted in two forms: a `leadIn` string (the v1 transport,
// composed inline into the message) and a `text/markdown` `attachment` (the
// first-class Interchange-attachment transport, kept ready but NOT sent in v1).
// The spike (CL-2495) found Myra's DeepSeek/openai-compatible harness rejects
// document attachment ContentBlocks, so the projection must travel as prose
// until the bound model reads document blocks.

export const ActiveContextKindSchema = type(
  "'artifact' | 'workflow-run' | 'thread'",
);
export type ActiveContextKind = typeof ActiveContextKindSchema.infer;

/** The lightweight identity a pill renders from. */
export const ActiveContextRefSchema = type({
  kind: ActiveContextKindSchema,
  id: "string",
  label: "string",
});
export type ActiveContextRef = typeof ActiveContextRefSchema.infer;

export const ArtifactContextSchema = type({
  kind: "'artifact'",
  id: "string",
  label: "string",
  artifactKind: "string",
  body: "string",
});
export type ArtifactContext = typeof ArtifactContextSchema.infer;

export const WorkflowRunStepSchema = type({
  name: "string",
  status: "string",
  "output?": "string",
});
export type WorkflowRunStep = typeof WorkflowRunStepSchema.infer;

export const WorkflowRunContextSchema = type({
  kind: "'workflow-run'",
  id: "string",
  label: "string",
  runKind: "string",
  status: "string",
  "inputs?": "string",
  steps: WorkflowRunStepSchema.array(),
  "artifactsProduced?": "string[]",
});
export type WorkflowRunContext = typeof WorkflowRunContextSchema.infer;

export const ThreadTurnSchema = type({
  role: "'user' | 'agent'",
  text: "string",
});
export type ThreadTurn = typeof ThreadTurnSchema.infer;

export const ThreadContextSchema = type({
  kind: "'thread'",
  id: "string",
  label: "string",
  turns: ThreadTurnSchema.array(),
});
export type ThreadContext = typeof ThreadContextSchema.infer;

export const ActiveContextSchema = ArtifactContextSchema.or(
  WorkflowRunContextSchema,
).or(ThreadContextSchema);
export type ActiveContext = typeof ActiveContextSchema.infer;

/**
 * Structurally identical to `@intx/types` `MessageAttachment` so a future
 * transport can hand it straight to `OutboundMessage.attachments`. Kept local
 * because `@workbench/shared` takes no Interchange dependency, and `data`
 * (a `Uint8Array`) is not expressible as an arktype schema.
 */
export interface ProjectionAttachment {
  name: string;
  contentType: string;
  data: Uint8Array;
}

export interface ActiveContextProjection {
  /** Compact, model-visible lead-in composed inline into the chat message. */
  leadIn: string;
  /** The same projection as a `text/markdown` attachment. Not sent in v1. */
  attachment: ProjectionAttachment;
}

// Per-kind size bounds. The projection is token-efficient by construction: a
// projector that starts dumping a full entity will overflow these and fail the
// unit tests.
export const ARTIFACT_BODY_MAX_CHARS = 1800;
export const WORKFLOW_INPUTS_MAX_CHARS = 600;
export const WORKFLOW_STEP_OUTPUT_MAX_CHARS = 400;
export const WORKFLOW_MAX_STEPS = 12;
export const THREAD_TURN_MAX_CHARS = 280;
export const THREAD_MAX_TURNS = 8;

const TRUNCATION_MARKER = "…";

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}${TRUNCATION_MARKER}`;
}

function projectArtifactContext(ctx: ArtifactContext): string {
  return [
    `Active context — artifact "${ctx.label}"`,
    `- id: ${ctx.id}`,
    `- kind: ${ctx.artifactKind}`,
    "",
    "Excerpt:",
    truncate(ctx.body.trim(), ARTIFACT_BODY_MAX_CHARS),
    "",
    "Load the full, current content with artifact_read before responding.",
  ].join("\n");
}

function projectWorkflowRunContext(ctx: WorkflowRunContext): string {
  const lines = [
    `Active context — workflow run "${ctx.label}"`,
    `- id: ${ctx.id}`,
    `- workflow: ${ctx.runKind}`,
    `- status: ${ctx.status}`,
  ];

  if (ctx.inputs !== undefined && ctx.inputs.length > 0) {
    lines.push("", "Inputs:", truncate(ctx.inputs, WORKFLOW_INPUTS_MAX_CHARS));
  }

  const shown = ctx.steps.slice(0, WORKFLOW_MAX_STEPS);
  if (shown.length > 0) {
    lines.push("", "Steps:");
    for (const step of shown) {
      const head = `- ${step.name} [${step.status}]`;
      if (step.output !== undefined && step.output.length > 0) {
        lines.push(
          `${head}: ${truncate(step.output, WORKFLOW_STEP_OUTPUT_MAX_CHARS)}`,
        );
      } else {
        lines.push(head);
      }
    }
    const remaining = ctx.steps.length - shown.length;
    if (remaining > 0) {
      lines.push(`- …and ${remaining} more step(s)`);
    }
  }

  if (ctx.artifactsProduced !== undefined && ctx.artifactsProduced.length > 0) {
    lines.push("", `Artifacts produced: ${ctx.artifactsProduced.join(", ")}`);
  }

  return lines.join("\n");
}

function projectThreadContext(ctx: ThreadContext): string {
  const turns = ctx.turns.slice(-THREAD_MAX_TURNS);
  const lines = [
    `Active context — chat thread "${ctx.label}"`,
    `- id: ${ctx.id}`,
  ];
  if (turns.length > 0) {
    lines.push("", "Recent turns:");
    for (const turn of turns) {
      const who = turn.role === "user" ? "User" : "Agent";
      lines.push(
        `${who}: ${truncate(turn.text.trim(), THREAD_TURN_MAX_CHARS)}`,
      );
    }
  }
  return lines.join("\n");
}

// The per-kind registry. Adding a fourth surface kind is a new entry here plus a
// schema above — never a change in the consuming app.
const projectors: {
  artifact: (ctx: ArtifactContext) => string;
  "workflow-run": (ctx: WorkflowRunContext) => string;
  thread: (ctx: ThreadContext) => string;
} = {
  artifact: projectArtifactContext,
  "workflow-run": projectWorkflowRunContext,
  thread: projectThreadContext,
};

function buildLeadIn(ctx: ActiveContext): string {
  switch (ctx.kind) {
    case "artifact":
      return projectors.artifact(ctx);
    case "workflow-run":
      return projectors["workflow-run"](ctx);
    case "thread":
      return projectors.thread(ctx);
  }
}

const ATTACHMENT_CONTENT_TYPE = "text/markdown";

export function activeContextToRef(ctx: ActiveContext): ActiveContextRef {
  return { kind: ctx.kind, id: ctx.id, label: ctx.label };
}

export function projectActiveContext(
  ctx: ActiveContext,
): ActiveContextProjection {
  const leadIn = buildLeadIn(ctx);
  return {
    leadIn,
    attachment: {
      name: `active-context-${ctx.kind}-${ctx.id}.md`,
      contentType: ATTACHMENT_CONTENT_TYPE,
      data: new TextEncoder().encode(leadIn),
    },
  };
}
