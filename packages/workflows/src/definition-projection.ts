// Reads a `WorkflowDefinition`'s launch body back out of an already-resolved
// inert wire projection. See docs/workflow-definition-projection.md.
import type { FoldedBody } from "@intx/workflow-deploy";
import { GrantRequirement, CredentialBinding } from "@intx/types";
import { ToolPackagePin } from "@intx/types/tool-packages";
import { type } from "arktype";

/** Thrown when a definition carries no frozen wire projection. Carries
 * consumer-facing `guidance` so an HTTP boundary can answer 4xx, not 500. */
export class DefinitionProjectionMissingError extends Error {
  readonly definitionName: string;
  readonly guidance: string;
  constructor(definitionName: string) {
    const guidance =
      "This agent isn't finished setting up. Open it in Agents, save " +
      "its instructions, and try again — or recreate it.";
    super(`No stored launch body for definition "${definitionName}" (${guidance})`);
    this.name = "DefinitionProjectionMissingError";
    this.definitionName = definitionName;
    this.guidance = guidance;
  }
}

/** One definition candidate, ordered newest-first by the caller
 * (typically `createdAt desc`). */
export type DefinitionCandidate = {
  readonly id: string;
  readonly name: string;
};

/** Thrown when a definition's frozen projection carries more than one step —
 * this launch target has no notion of step order. See
 * docs/workflow-definition-projection.md#why-multi-step-definitions-are-rejected. */
export class MultiStepFoldUnsupportedError extends Error {
  readonly definitionId: string;
  readonly stepCount: number;
  readonly guidance: string;
  constructor(definitionId: string, stepCount: number) {
    const guidance =
      "This agent has multiple workflow steps, which this launch path " +
      "does not yet support — only its first step would run. Reduce it " +
      "to a single step, or wait for multi-step routine launch support.";
    super(
      `definition ${definitionId} is not single-step (${String(stepCount)} steps) (${guidance})`,
    );
    this.name = "MultiStepFoldUnsupportedError";
    this.definitionId = definitionId;
    this.stepCount = stepCount;
    this.guidance = guidance;
  }
}

/** The launch-relevant subset of an inert projection's `step` primitive,
 * after the projector flattens the live `AgentDefinition`'s inference chain. */
const InertWorkflowStepSchema = type({
  kind: "'step'",
  agent: {
    systemPrompt: "string",
    "toolPackagePins?": ToolPackagePin.array(),
    modelSources: type({ model: "string" }).array(),
  },
});

/** The launch-relevant subset of an inert projection's `onTrigger`
 * primitive — the agent-bearing step lives inside the section's inline body. */
const InertOnTriggerStepSchema = type({
  kind: "'onTrigger'",
  body: {
    inline: {
      stepOrder: "string[]",
      steps: "Record<string, unknown>",
    },
  },
});

/** Extracts the agent-bearing step, whichever of the two launch-step shapes
 * a projection takes. See docs/workflow-definition-projection.md#step-shapes. */
function extractAgentBearingStep(
  rawStep: unknown,
  definitionId: string,
  stepId: string,
): typeof InertWorkflowStepSchema.infer {
  const asStep = InertWorkflowStepSchema(rawStep);
  if (!(asStep instanceof type.errors)) {
    return asStep;
  }
  const asSection = InertOnTriggerStepSchema(rawStep);
  if (asSection instanceof type.errors) {
    throw new Error(
      `definition ${definitionId} step ${stepId} is not a step primitive: ${asStep.summary}`,
    );
  }
  const body = asSection.body.inline;
  const [bodyStepId, ...bodyRest] = body.stepOrder;
  if (bodyStepId === undefined || bodyRest.length > 0) {
    throw new Error(
      `definition ${definitionId} section ${stepId}'s body is not ` +
        `single-step (${String(body.stepOrder.length)} steps)`,
    );
  }
  const bodyStep = InertWorkflowStepSchema(body.steps[bodyStepId]);
  if (bodyStep instanceof type.errors) {
    throw new Error(
      `definition ${definitionId} section ${stepId} body step ` +
        `${bodyStepId} is not a step primitive: ${bodyStep.summary}`,
    );
  }
  return bodyStep;
}

/** The launch-relevant subset of an inert projection itself. */
const InertWorkflowDefinitionSchema = type({
  id: "string",
  stepOrder: "string[]",
  steps: "Record<string, unknown>",
  "credentialBindings?": CredentialBinding.array(),
});

export const FoldedBodySchema = type({
  systemPrompt: "string",
  toolPackagePins: ToolPackagePin.array(),
  grantRequirements: GrantRequirement.array(),
  credentialBindings: CredentialBinding.array(),
  model: "string | null",
});

/** Reads the launch body off a frozen inert projection instead of a live
 * `WorkflowDefinition`. `grantRequirements` comes from the caller since the
 * projector drops it. */
export function readFoldedBody(projection: unknown, grantRequirements: unknown): FoldedBody {
  const definition = InertWorkflowDefinitionSchema(projection);
  if (definition instanceof type.errors) {
    throw new Error(`inert projection is malformed: ${definition.summary}`);
  }
  const [stepId, ...rest] = definition.stepOrder;
  if (stepId === undefined || rest.length > 0) {
    throw new MultiStepFoldUnsupportedError(definition.id, definition.stepOrder.length);
  }
  const step = extractAgentBearingStep(definition.steps[stepId], definition.id, stepId);
  const foldedBody = FoldedBodySchema({
    systemPrompt: step.agent.systemPrompt,
    toolPackagePins: step.agent.toolPackagePins ?? [],
    grantRequirements: grantRequirements ?? [],
    credentialBindings: definition.credentialBindings ?? [],
    model: step.agent.modelSources[0]?.model ?? null,
  });
  if (foldedBody instanceof type.errors) {
    throw new Error(
      `definition ${definition.id} produced an invalid folded body: ${foldedBody.summary}`,
    );
  }
  return foldedBody;
}
