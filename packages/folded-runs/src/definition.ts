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
//
// A definition carries its one agent step in either of the two shapes
// the platform authors: directly, or inside an `onTrigger` section
// (CL-6329's per-turn room agents). Both readers below unwrap the
// section, so a launch body reads the same either way.
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
      "This agent was deployed before the hub started recording its " +
      "launch body — re-deploy it (run seed / republish) and try again.";
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
 * An `onTrigger` section carrying its body inline. Section mode
 * (`@corbits/agent-runtime`'s `buildAgentRuntimeWorkflow`) wraps the one
 * agent step in a section so every message becomes its own occurrence,
 * so a run's launch body lives one level down. The wrapper carries no
 * launch body of its own: everything `FoldedBodySchema` needs is on the
 * agent step inside.
 */
const OnTriggerSectionSchema = type({
  kind: "'onTrigger'",
  body: {
    inline: {
      stepOrder: "string[]",
      steps: "Record<string, unknown>",
    },
  },
});

/**
 * The one agent-bearing step of a definition that carries exactly one:
 * the step itself in folded mode, the section body's step in section
 * mode. `label` names the shape being read so a failure says which
 * reader saw it.
 */
function soleStep(
  definitionId: string,
  stepOrder: readonly string[],
  steps: Record<string, unknown>,
  label: string,
): { stepId: string; step: unknown } {
  const [stepId, ...rest] = stepOrder;
  if (stepId === undefined || rest.length > 0) {
    throw new Error(
      `${label} ${definitionId} is not single-step (${String(
        stepOrder.length,
      )} steps)`,
    );
  }
  const step = steps[stepId];
  const section = OnTriggerSectionSchema(step);
  if (section instanceof type.errors) {
    return { stepId, step };
  }
  return soleStep(
    definitionId,
    section.body.inline.stepOrder,
    section.body.inline.steps,
    label,
  );
}

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
  const sole = soleStep(
    definition.id,
    definition.stepOrder,
    definition.steps,
    "definition",
  );
  const stepId = sole.stepId;
  const step = InertWorkflowStepSchema(sole.step);
  if (step instanceof type.errors) {
    throw new Error(
      `definition ${definition.id} step ${stepId} is not a step primitive: ${step.summary}`,
    );
  }
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
  const sole = soleStep(
    definition.id,
    definition.stepOrder,
    definition.steps,
    "live definition",
  );
  const stepId = sole.stepId;
  const step = LiveWorkflowStepSchema(sole.step);
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
