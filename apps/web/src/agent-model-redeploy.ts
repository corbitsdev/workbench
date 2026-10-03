// Re-deploys a hand-authored agent onto the workspace's current inference
// offering after the provider changed since its last deploy — the same
// `deployAgentSource` pipeline that created it, with its config carried
// over, so nothing the person set is lost in the move.
import {
  agentSlugFromSourceAssetName,
  deployAgentSource,
  type DeployedAgent,
  type NewAgentInput,
} from "./agent-deploy";
import { readAgentMcpHandles, readAgentSource } from "./agent-source-read";
import type { ChatAgent } from "./chat/threads-api";
import { resolveExistingOffering, type DeclaredSource } from "./onboarding/provider-connect-step";
import type { Grant } from "./settings/tenancy-api";
import { readWorkerToolGrants, toolEffectsToCarry } from "./worker-tool-grants";

export class AgentRedeployError extends Error {}

/** An inference source as either side of the comparison carries it: the
 * agent's deployed declaration (plain strings off the source tree) and the
 * workspace's current offering (plugin-typed) alike. */
export type InferenceSource = {
  readonly provider: string;
  readonly model: string;
};

/** True when the agent's declared inference sources no longer match the
 * workspace's current offering — its runs still pin the old provider, so a
 * redeploy is the only way onto the new one. Quiet when no provider is
 * connected yet, since there is nothing to move onto. */
export function needsAgentRedeployForProviderChange(
  declared: readonly InferenceSource[],
  current: readonly InferenceSource[] | null,
): boolean {
  if (current === null) return false;
  return (
    declared.length !== current.length ||
    declared.some(
      (source, index) =>
        source.provider !== current[index]?.provider || source.model !== current[index]?.model,
    )
  );
}

/** The redeploy input that keeps the agent's config: its name and address
 * slug, its instructions, its bound servers, and its non-ask permissions —
 * ask-gated tools stay ask-gated by falling back to the deploy default. */
export function buildAgentRedeployInput(args: {
  readonly name: string;
  readonly slug: string;
  readonly systemPrompt: string;
  readonly mcpHandles: readonly string[];
  readonly toolGrants: readonly Grant[];
}): NewAgentInput {
  return {
    name: args.name,
    slug: args.slug,
    systemPrompt: args.systemPrompt,
    mcpHandles: args.mcpHandles,
    toolEffects: toolEffectsToCarry(args.toolGrants),
    redeploy: true,
  };
}

/** The workspace's current offering, or null when no provider is connected. */
export function readCurrentOfferingSources(
  tenantId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly DeclaredSource[] | null> {
  return resolveExistingOffering(tenantId, fetchImpl).then(
    (offering) => offering?.declaredSources ?? null,
  );
}

/**
 * Re-deploys an existing agent onto the current offering, preserving its
 * config. Fails closed for the default worker and anything this pipeline
 * didn't deploy (no slug to keep the address stable under), and when no
 * provider is connected yet (`deployAgentSource` throws there).
 */
export async function redeployAgentForProviderChange(
  args: { readonly tenantId: string; readonly agent: ChatAgent },
  fetchImpl: typeof fetch = fetch,
): Promise<DeployedAgent> {
  const slug = agentSlugFromSourceAssetName(args.agent.assetName);
  if (slug === null) {
    throw new AgentRedeployError(`${args.agent.assetName} was not deployed by this workbench`);
  }
  const [source, mcpHandles, grants] = await Promise.all([
    readAgentSource(args.tenantId, args.agent.id, args.agent.assetName, fetchImpl),
    readAgentMcpHandles(args.tenantId, args.agent.id, args.agent.assetName, fetchImpl),
    readWorkerToolGrants(args.tenantId, args.agent),
  ]);
  return deployAgentSource(
    {
      tenantId: args.tenantId,
      input: buildAgentRedeployInput({
        name: args.agent.name,
        slug,
        systemPrompt: source.systemPrompt,
        mcpHandles,
        toolGrants: grants?.tools ?? [],
      }),
    },
    fetchImpl,
  );
}
