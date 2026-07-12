import { generateId } from "@intx/hub-common";
import { resolveModelSources } from "@intx/db";
import type { ModelRequirement } from "@intx/types";
import type { HarnessConfig, InferenceSource } from "@intx/types/runtime";
import type { DeployContent } from "@intx/hub-sessions";
import type { WorkflowDefinition } from "@intx/workflow";
import { LLM_DEFAULT_MODEL } from "@workbench/agents";
import type { HubDb } from "../db";
import { getCachedCatalogSources } from "./workflow-model-source-cache";

export type WorkflowDeployConfig = {
  deploymentId: string;
  config: HarnessConfig;
  deployContent: DeployContent;
};

// The distinct non-default models a workflow's steps declare as a preferred
// inference source (via `inlineInferenceStep({ model })`). The deploy resolves
// these into `config.sources` IN ADDITION to the default chain so a step that
// prefers one can pin it. Driving the extra-model set off the definition keeps
// the per-step model a property of the workflow that declares it — the generic
// hub deploy path never names a specific model. Defensive reads: the primitive
// is reconstructed from persisted JSON.
export function collectDeclaredStepModels(
  definition: WorkflowDefinition,
): string[] {
  const models = new Set<string>();
  for (const stepId of definition.stepOrder) {
    const primitive = definition.steps[stepId];
    if (primitive === undefined || primitive.kind !== "step") continue;
    for (const source of primitive.agent?.inference?.sources ?? []) {
      if (source.model !== "" && source.model !== LLM_DEFAULT_MODEL) {
        models.add(source.model);
      }
    }
  }
  return [...models];
}

// The per-step output-token ceiling a step declares on its preferred inference
// source (via `inlineInferenceStep({ model, maxTokens })`, carried as
// `parameters.maxTokens`). Keyed by model so the deploy can lift it onto the
// matching resolved `InferenceSource.defaults.maxTokens` — the source-level knob
// the runtime merges into each call. Without this a heavy writer step runs on the
// source's small/unset default and truncates cleanly at `finish_reason:"length"`.
// Defensive reads: the primitive is reconstructed from persisted JSON. When two
// steps declare different ceilings for the same model, the larger wins (a higher
// ceiling never truncates a step that wanted less).
export function collectDeclaredStepModelMaxTokens(
  definition: WorkflowDefinition,
): Map<string, number> {
  const byModel = new Map<string, number>();
  for (const stepId of definition.stepOrder) {
    const primitive = definition.steps[stepId];
    if (primitive === undefined || primitive.kind !== "step") continue;
    for (const source of primitive.agent?.inference?.sources ?? []) {
      if (source.model === "" || source.model === LLM_DEFAULT_MODEL) continue;
      const raw = source.parameters?.maxTokens;
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
        continue;
      const existing = byModel.get(source.model);
      if (existing === undefined || raw > existing) {
        byModel.set(source.model, raw);
      }
    }
  }
  return byModel;
}

// Lift each declared per-model maxTokens onto the matching resolved source's
// `defaults.maxTokens`. Returns fresh source objects (never mutates the
// catalog-resolved ones) so the ceiling rides into STEP_INFERENCE_SOURCES via
// pickStepInferenceSource without disturbing the resolver's cache.
function applyModelMaxTokens(
  sources: InferenceSource[],
  modelMaxTokens: ReadonlyMap<string, number>,
): InferenceSource[] {
  if (modelMaxTokens.size === 0) return sources;
  return sources.map((source) => {
    const maxTokens = modelMaxTokens.get(source.model);
    if (maxTokens === undefined) return source;
    return {
      ...source,
      defaults: { ...source.defaults, maxTokens },
    };
  });
}

// Resolve the tenant's inference sources for native workflows from the tenant
// catalog. `resolveModelSources` returns the offerings for the required model
// ordered as a routing chain — head = default, tail = failover — so the deploy
// approves the whole chain and pins the head as `defaultSource`. Split out from
// config assembly so a re-drive (the deployment reconciler / run-start
// resilience) can rebuild config for an EXISTING deploymentId
// without minting a new one.
//
// The catalog is the operator-approved set: every source it returns is an
// offering the operator made tenant-visible, which is what
// `pickStepInferenceSource` cross-checks the deploy's defaultSource against.
// Resolve the tenant catalog sources from the DB, uncached. The default model
// chain is required; each extra step-preferred model is resolved optionally via
// its own round-trip (this is the loop the CL-2760 cache collapses).
async function resolveCatalogSourcesUncached(
  db: HubDb,
  tenantId: string,
  extraModels: readonly string[],
): Promise<InferenceSource[]> {
  const requirement: ModelRequirement = { model: LLM_DEFAULT_MODEL };
  const resolution = await resolveModelSources(db, tenantId, [requirement]);
  if (!resolution.ok) {
    if (resolution.reason === "no_requirements") {
      throw new Error(
        `workflow deploy: no model requirement to resolve for tenant ${tenantId}`,
      );
    }
    const skips = resolution.skips
      .map((s) => `${s.provider} (${s.reason})`)
      .join(", ");
    const detail =
      skips.length > 0 ? `; skipped: ${skips}` : " (empty tenant catalog)";
    throw new Error(
      `workflow deploy: model "${resolution.model}" is unavailable in tenant ${tenantId}${detail}`,
    );
  }
  // The default model chain is required; its head is the deploy defaultSource.
  // Step-preferred models are OPTIONAL — a step opts into one via a per-step
  // preference, and pickStepInferenceSource falls back to the default when it is
  // absent. Resolve each (the default is already covered and excluded by
  // collectDeclaredStepModels) and append only the offerings the catalog carries,
  // so the deploy never fails on a preferred model the tenant lacks.
  const sources = [...resolution.sources];
  for (const model of extraModels) {
    const extra = await resolveModelSources(db, tenantId, [{ model }]);
    if (!extra.ok) continue;
    for (const source of extra.sources) {
      const present = sources.some(
        (s) => s.provider === source.provider && s.model === source.model,
      );
      if (!present) sources.push(source);
    }
  }
  return sources;
}

export async function resolveWorkflowDeploySource(args: {
  db: HubDb;
  tenantId: string;
  // Extra models some step prefers (see `collectDeclaredStepModels`). Resolved
  // optionally and appended after the required default chain.
  extraModels?: readonly string[];
  // Per-model output-token ceilings a step declared (see
  // `collectDeclaredStepModelMaxTokens`). Lifted onto the matching resolved
  // source's `defaults.maxTokens`.
  modelMaxTokens?: ReadonlyMap<string, number>;
}): Promise<InferenceSource[]> {
  const extraModels = args.extraModels ?? [];
  // Catalog resolution is memoized per (tenant, declared-model set) with a short
  // TTL; maxTokens is a cheap pure map lifted onto fresh copies afterward, so it
  // stays outside the cache and can vary per caller without a re-resolve.
  const sources = await getCachedCatalogSources({
    tenantId: args.tenantId,
    extraModels,
    resolve: () =>
      resolveCatalogSourcesUncached(args.db, args.tenantId, extraModels),
  });
  return applyModelMaxTokens([...sources], args.modelMaxTokens ?? new Map());
}

// Assemble the base HarnessConfig from a resolved source chain and a
// caller-supplied deploymentId. The orchestrator overrides each step's address
// and prompt; the base only carries the tenant inference sources the steps pin
// against, with the chain head as the default. A re-drive passes the persisted
// deploymentId so derived step/supervisor addresses match the rows the original
// deploy wrote.
export function assembleWorkflowDeployConfig(args: {
  deploymentId: string;
  tenantId: string;
  principalId: string;
  deploymentDomain: string;
  sources: InferenceSource[];
}): WorkflowDeployConfig {
  const [head] = args.sources;
  if (head === undefined) {
    throw new Error(
      "workflow deploy: cannot assemble config with no inference sources",
    );
  }
  return {
    deploymentId: args.deploymentId,
    config: {
      sessionId: generateId("session"),
      agentId: args.deploymentId,
      tenantId: args.tenantId,
      principalId: args.principalId,
      agentAddress: `${args.deploymentId}@${args.deploymentDomain}`,
      systemPrompt: "",
      tools: [],
      grants: [],
      sources: args.sources,
      defaultSource: head.id,
    },
    deployContent: { systemPrompt: "" },
  };
}

// Builds the base HarnessConfig for a FRESH deploy, minting a new deploymentId.
// The definition supplies the per-step model preferences to resolve alongside the
// default chain.
export async function resolveWorkflowDeployConfig(args: {
  db: HubDb;
  tenantId: string;
  principalId: string;
  deploymentDomain: string;
  definition: WorkflowDefinition;
}): Promise<WorkflowDeployConfig> {
  const sources = await resolveWorkflowDeploySource({
    db: args.db,
    tenantId: args.tenantId,
    extraModels: collectDeclaredStepModels(args.definition),
    modelMaxTokens: collectDeclaredStepModelMaxTokens(args.definition),
  });
  return assembleWorkflowDeployConfig({
    deploymentId: generateId("session"),
    tenantId: args.tenantId,
    principalId: args.principalId,
    deploymentDomain: args.deploymentDomain,
    sources,
  });
}
