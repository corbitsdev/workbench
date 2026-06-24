import { generateId } from '@intx/hub-common';
import { resolveModelSources } from '@intx/db';
import type { ModelRequirement } from '@intx/types';
import type { HarnessConfig, InferenceSource } from '@intx/types/runtime';
import type { DeployContent } from '@intx/hub-sessions';
import { LLM_DEFAULT_MODEL } from '@workbench/agents';
import type { HubDb } from '../db';

export type WorkflowDeployConfig = {
  deploymentId: string;
  config: HarnessConfig;
  deployContent: DeployContent;
};

// Resolve the tenant's inference sources for native workflows from the tenant
// catalog. `resolveModelSources` returns the offerings for the required model
// ordered as a routing chain — head = default, tail = failover — so the deploy
// approves the whole chain and pins the head as `defaultSource`. Split out from
// config assembly so a re-drive (the deployment reconciler / run-start
// resilience, CL-2224/CL-2225) can rebuild config for an EXISTING deploymentId
// without minting a new one.
//
// The catalog is the operator-approved set: every source it returns is an
// offering the operator made tenant-visible, which is what
// `pickStepInferenceSource` cross-checks the deploy's defaultSource against.
export async function resolveWorkflowDeploySource(args: {
  db: HubDb;
  tenantId: string;
}): Promise<InferenceSource[]> {
  const requirement: ModelRequirement = { model: LLM_DEFAULT_MODEL };
  const resolution = await resolveModelSources(args.db, args.tenantId, [requirement]);
  if (!resolution.ok) {
    if (resolution.reason === 'no_requirements') {
      throw new Error(
        `workflow deploy: no model requirement to resolve for tenant ${args.tenantId}`
      );
    }
    const skips = resolution.skips.map((s) => `${s.provider} (${s.reason})`).join(', ');
    const detail = skips.length > 0 ? `; skipped: ${skips}` : ' (empty tenant catalog)';
    throw new Error(
      `workflow deploy: model "${resolution.model}" is unavailable in tenant ${args.tenantId}${detail}`
    );
  }
  return resolution.sources;
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
    throw new Error('workflow deploy: cannot assemble config with no inference sources');
  }
  return {
    deploymentId: args.deploymentId,
    config: {
      sessionId: generateId('session'),
      agentId: args.deploymentId,
      tenantId: args.tenantId,
      principalId: args.principalId,
      agentAddress: `${args.deploymentId}@${args.deploymentDomain}`,
      systemPrompt: '',
      tools: [],
      grants: [],
      sources: args.sources,
      defaultSource: head.id,
    },
    deployContent: { systemPrompt: '' },
  };
}

// Builds the base HarnessConfig for a FRESH deploy, minting a new deploymentId.
export async function resolveWorkflowDeployConfig(args: {
  db: HubDb;
  tenantId: string;
  principalId: string;
  deploymentDomain: string;
}): Promise<WorkflowDeployConfig> {
  const sources = await resolveWorkflowDeploySource({
    db: args.db,
    tenantId: args.tenantId,
  });
  return assembleWorkflowDeployConfig({
    deploymentId: generateId('session'),
    tenantId: args.tenantId,
    principalId: args.principalId,
    deploymentDomain: args.deploymentDomain,
    sources,
  });
}
