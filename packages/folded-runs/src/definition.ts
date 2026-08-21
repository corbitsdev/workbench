// Reads a folded `WorkflowDefinition`'s launch body back out of the hub's
// own record of the definition.
//
// Under the `workflow.json` retirement a deployed definition's body is
// whatever its source closure evaluates to on the sidecar, and a
// source-format workflow asset carries no envelope to read it back from.
// The hub-side record of that body is the inert wire projection the
// approval freeze hashed, persisted on the definition's version row
// beside the hash that addresses it
// (`vendor/intx/db/src/workflow-definition-store.ts`'s
// `loadFrozenWireProjection`). This module is the single reader of that
// projection for launch purposes.
//
// One field of the launch body is deliberately NOT in the projection:
// `grantRequirements` does not survive the live->inert projector and is
// therefore outside the wire hash. Its hub-side home is the
// `workflow_definition.grant_requirements` column, so it is passed in
// alongside the projection rather than read off it.
import type { DB } from "@intx/db";
import { loadFrozenWireProjection } from "@intx/db";
import type { FoldedBody } from "@intx/workflow-deploy";
import { GrantRequirement, CredentialBinding } from "@intx/types";
import { ToolPackagePin } from "@intx/types/tool-packages";
import { type } from "arktype";

/**
 * Thrown when a definition carries no frozen wire projection — a row
 * persisted before the projection was stored, or one whose approval
 * never completed. Carries consumer language so an HTTP boundary can
 * answer with a named 4xx instead of an unhandled 500, mirroring
 * `InferenceResolutionError`'s split between the human `message` and the
 * `guidance` a caller surfaces verbatim.
 */
export class DefinitionProjectionMissingError extends Error {
  readonly definitionName: string;
  readonly guidance: string;
  constructor(definitionName: string) {
    const guidance =
      "This agent isn't finished setting up. Open it in Agents, save " +
      "its instructions, and try again — or recreate it.";
    super(
      `No stored launch body for definition "${definitionName}" (${guidance})`,
    );
    this.name = "DefinitionProjectionMissingError";
    this.definitionName = definitionName;
    this.guidance = guidance;
  }
}

/**
 * Read one definition's frozen inert projection, failing with the named
 * error above rather than a raw miss.
 */
export async function readDefinitionProjection(
  db: DB["db"],
  definition: { id: string; name: string },
): Promise<unknown> {
  const projection = await loadFrozenWireProjection(db, definition.id);
  if (projection === null) {
    throw new DefinitionProjectionMissingError(definition.name);
  }
  return projection;
}

/** One definition candidate for a name, ordered newest-first by the
 * caller (typically `createdAt desc`). */
export type DefinitionCandidate = {
  readonly id: string;
  readonly name: string;
};

/**
 * Resolves a definition's launch body by trying its candidates
 * newest-first and returning the first one that actually carries a
 * frozen projection — a stale pre-cutover sibling never wins over a
 * healthy newer one (the DB-side successor to CL-6357's asset-drift
 * walk). Raises `DefinitionProjectionMissingError` only once every
 * candidate has come back empty.
 */
export async function resolveNewestProjectedDefinition(
  db: DB["db"],
  candidates: readonly DefinitionCandidate[],
): Promise<{ definitionId: string; projection: unknown }> {
  for (const candidate of candidates) {
    const projection = await loadFrozenWireProjection(db, candidate.id);
    if (projection !== null) {
      return { definitionId: candidate.id, projection };
    }
  }
  const definitionName = candidates[0]?.name ?? "unknown";
  throw new DefinitionProjectionMissingError(definitionName);
}

/**
 * The launch-relevant subset of an inert projection's single `step`
 * primitive. The projector reifies the live `AgentDefinition` into plain
 * data and FLATTENS its inference chain: `agent.inference.sources`
 * becomes a top-level `modelSources: { provider, model }[]` and the
 * function-bearing `toolFactories` become descriptors. This schema
 * validates exactly the reified fields `readFoldedBody` below reads.
 */
const InertWorkflowStepSchema = type({
  kind: "'step'",
  agent: {
    systemPrompt: "string",
    "toolPackagePins?": ToolPackagePin.array(),
    modelSources: type({ model: "string" }).array(),
  },
});

/**
 * The launch-relevant subset of an inert projection's `onTrigger`
 * primitive (CL-6329's per-turn section shape,
 * `@corbits/agent-runtime`'s `buildSectionWorkflow`): the agent-bearing
 * step lives one level down, inside the section's inline body, not on
 * the section step itself. `readFoldedBody` below reads through this
 * shape the same way it reads a bare `step` primitive.
 */
const InertOnTriggerStepSchema = type({
  kind: "'onTrigger'",
  body: {
    inline: {
      stepOrder: "string[]",
      steps: "Record<string, unknown>",
    },
  },
});

/**
 * Extracts the agent-bearing step primitive `readFoldedBody` needs,
 * whichever of the two shapes a projection's launch step takes — a
 * bare `step` (the folded conversational shape) or an `onTrigger`
 * section whose inline body carries the one step that answers each
 * turn. One reader for both shapes: neither call site duplicates the
 * other's parsing.
 */
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

/**
 * The launch-relevant subset of a LIVE serialized `WorkflowDefinition`'s
 * step — the pre-projection shape, where the inference chain is still
 * nested at `agent.inference.sources`. This is not an alternative source
 * for a deployed definition's body: it serves the one caller that builds
 * its definition in process and launches it in the same breath (the
 * workbench host, `buildWorkbenchHostWorkflow`), which has the live
 * object in hand and never round-trips through a deploy freeze.
 */
const LiveWorkflowStepSchema = type({
  kind: "'step'",
  agent: {
    systemPrompt: "string",
    "toolPackagePins?": ToolPackagePin.array(),
    inference: {
      sources: type({ "model?": "string | null" }).array(),
    },
  },
});

const LiveWorkflowDefinitionSchema = type({
  id: "string",
  stepOrder: "string[]",
  steps: "Record<string, unknown>",
  "grantRequirements?": GrantRequirement.array(),
  "credentialBindings?": CredentialBinding.array(),
});

export const FoldedBodySchema = type({
  systemPrompt: "string",
  toolPackagePins: ToolPackagePin.array(),
  grantRequirements: GrantRequirement.array(),
  credentialBindings: CredentialBinding.array(),
  model: "string | null",
});

/**
 * Reads the launch body back out of a definition's frozen inert
 * projection — the same fields `@intx/workflow-deploy`'s
 * `extractFoldedBody` reads off a live `WorkflowDefinition`, read here
 * off the projected plain data instead. `grantRequirements` comes from
 * the definition row because the projector drops it (see the module
 * header).
 */
export function readFoldedBody(
  projection: unknown,
  grantRequirements: unknown,
): FoldedBody {
  const definition = InertWorkflowDefinitionSchema(projection);
  if (definition instanceof type.errors) {
    throw new Error(`inert projection is malformed: ${definition.summary}`);
  }
  const [stepId, ...rest] = definition.stepOrder;
  if (stepId === undefined || rest.length > 0) {
    throw new Error(
      `definition ${definition.id} is not single-step (${String(
        definition.stepOrder.length,
      )} steps)`,
    );
  }
  const step = extractAgentBearingStep(
    definition.steps[stepId],
    definition.id,
    stepId,
  );
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

/**
 * Reads the launch body out of a live serialized `WorkflowDefinition` —
 * the in-process launch path described on `LiveWorkflowStepSchema`.
 * Unlike the projection, a live definition still carries its own
 * `grantRequirements`, so nothing is passed in beside it.
 */
export function readLiveFoldedBody(raw: unknown): FoldedBody {
  const definition = LiveWorkflowDefinitionSchema(raw);
  if (definition instanceof type.errors) {
    throw new Error(`live definition is malformed: ${definition.summary}`);
  }
  const [stepId, ...rest] = definition.stepOrder;
  if (stepId === undefined || rest.length > 0) {
    throw new Error(
      `live definition ${definition.id} is not single-step (${String(
        definition.stepOrder.length,
      )} steps)`,
    );
  }
  const step = LiveWorkflowStepSchema(definition.steps[stepId]);
  if (step instanceof type.errors) {
    throw new Error(
      `live definition ${definition.id} step ${stepId} is not a step primitive: ${step.summary}`,
    );
  }
  const foldedBody = FoldedBodySchema({
    systemPrompt: step.agent.systemPrompt,
    toolPackagePins: step.agent.toolPackagePins ?? [],
    grantRequirements: definition.grantRequirements ?? [],
    credentialBindings: definition.credentialBindings ?? [],
    model: step.agent.inference.sources[0]?.model ?? null,
  });
  if (foldedBody instanceof type.errors) {
    throw new Error(
      `live definition ${definition.id} produced an invalid folded body: ${foldedBody.summary}`,
    );
  }
  return foldedBody;
}
