// Reads a folded `WorkflowDefinition`'s launch body back out of its
// materialized workflow asset. Reimplemented here rather than imported
// from `@intx/hub-api`'s `run-grant-materialization.ts` (the reference
// `POST /workflows/runs` route's own helper): that module is
// hub-api-internal, not part of its published surface — the same
// module-privacy reason `@corbits/chat`'s `workbench-workflow.ts`
// reimplements `assertJsonPortable` rather than reaching into another
// package's internals.
import type { AssetService } from "@intx/hub-sessions";
import { WORKFLOW_JSON_PATH } from "@intx/hub-sessions";
import type { FoldedBody } from "@intx/workflow-deploy";
import { GrantRequirement, CredentialBinding } from "@intx/types";
import { ToolPackagePin } from "@intx/types/tool-packages";
import { type } from "arktype";

export async function readDefinitionJSON(
  assetService: AssetService,
  assetId: string,
): Promise<unknown> {
  const raw = await assetService.readAssetBlob({
    assetId,
    path: WORKFLOW_JSON_PATH,
  });
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch (cause) {
    throw new Error(
      `workflow asset ${assetId} ${WORKFLOW_JSON_PATH} is not valid JSON`,
      { cause },
    );
  }
}

/**
 * Thrown by `resolveNewestReadableDefinitionJSON` when every candidate
 * asset for a definition's name is unresolvable (DB/blob drift — a
 * long-lived DB whose asset rows outlive the git repos they point at,
 * or an asset row that predates a `.data` reset). Carries consumer
 * language so an HTTP boundary can answer with a named 4xx instead of
 * an unhandled 500, mirroring `InferenceResolutionError`'s split
 * between the human `message` and the `guidance` a caller surfaces
 * verbatim.
 */
export class DefinitionAssetUnresolvableError extends Error {
  readonly definitionName: string;
  readonly guidance: string;
  constructor(definitionName: string) {
    const guidance =
      "This agent's definition needs re-publishing — run seed / republish.";
    super(
      `No resolvable asset for definition "${definitionName}" ` +
        `(${String(guidance)})`,
    );
    this.name = "DefinitionAssetUnresolvableError";
    this.definitionName = definitionName;
    this.guidance = guidance;
  }
}

/** One asset candidate for a definition's name, ordered newest-first
 * by the caller (typically `createdAt desc`). */
export type DefinitionAssetCandidate = {
  readonly assetId: string;
  readonly definitionName: string;
};

/**
 * Resolves a definition's launch body by trying its asset candidates
 * newest-first and returning the first one whose ref actually reads —
 * a stale unresolvable asset never wins over a healthy newer one
 * (CL-6357). Raises `DefinitionAssetUnresolvableError` only once every
 * candidate has failed to resolve.
 */
export async function resolveNewestReadableDefinitionJSON(
  assetService: AssetService,
  candidates: readonly DefinitionAssetCandidate[],
): Promise<{ assetId: string; definitionJSON: unknown }> {
  for (const candidate of candidates) {
    try {
      const definitionJSON = await readDefinitionJSON(
        assetService,
        candidate.assetId,
      );
      return { assetId: candidate.assetId, definitionJSON };
    } catch {
      continue;
    }
  }
  const definitionName = candidates[0]?.definitionName ?? "unknown";
  throw new DefinitionAssetUnresolvableError(definitionName);
}

/**
 * The launch-relevant subset of a folded `WorkflowDefinition`'s single
 * `step` primitive: `AgentDefinition` itself is not JSON-portable (its
 * `toolFactories` are functions), so `@intx/workflow`'s real
 * `WorkflowDefinition` type is not something a parsed JSON blob can
 * ever honestly satisfy — narrowing to it with a cast would just
 * assert the untyped parts into existence. This schema instead
 * validates exactly the fields a folded definition's step carries that
 * `readFoldedBody` below reads.
 */
const FoldedWorkflowStepSchema = type({
  kind: "'step'",
  agent: {
    systemPrompt: "string",
    "toolPackagePins?": ToolPackagePin.array(),
    inference: {
      sources: type({ "model?": "string | null" }).array(),
    },
  },
});

/** The launch-relevant subset of a folded `WorkflowDefinition` itself. */
const FoldedWorkflowDefinitionSchema = type({
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
 * Reads the launch body back out of parsed workflow-definition JSON —
 * the same fields `@intx/workflow-deploy`'s `extractFoldedBody` reads
 * off a real `WorkflowDefinition`, reimplemented against the validated
 * JSON-portable subset above rather than casting a parsed blob into
 * that richer, function-bearing type.
 */
export function readFoldedBody(raw: unknown): FoldedBody {
  const definition = FoldedWorkflowDefinitionSchema(raw);
  if (definition instanceof type.errors) {
    throw new Error(`folded definition is malformed: ${definition.summary}`);
  }
  const [stepId, ...rest] = definition.stepOrder;
  if (stepId === undefined || rest.length > 0) {
    throw new Error(
      `folded definition ${definition.id} is not single-step (${String(
        definition.stepOrder.length,
      )} steps)`,
    );
  }
  const step = FoldedWorkflowStepSchema(definition.steps[stepId]);
  if (step instanceof type.errors) {
    throw new Error(
      `folded definition ${definition.id} step ${stepId} is not a step primitive: ${step.summary}`,
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
      `folded definition ${definition.id} produced an invalid folded body: ${foldedBody.summary}`,
    );
  }
  return foldedBody;
}
