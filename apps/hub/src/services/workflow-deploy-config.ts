import { generateId } from '@intx/hub-common';
import { resolveOneCredential } from '@intx/db';
import type { HarnessConfig } from '@intx/types/runtime';
import type { DeployContent } from '@intx/hub-sessions';
import { LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';
import type { HubDb } from '../db';

const LLM_PROVIDER = 'openai-compatible';

export type WorkflowDeployConfig = {
  deploymentId: string;
  config: HarnessConfig;
  deployContent: DeployContent;
};

// Builds the base HarnessConfig a workflow deploy shares across its steps. The
// orchestrator overrides each step's address and prompt from the step agent;
// the base only carries the tenant inference source the steps pin against.
// Today every native workflow runs on the shared tenant LLM source; per-source
// workflows extend this resolver when they land.
export async function resolveWorkflowDeployConfig(args: {
  db: HubDb;
  tenantId: string;
  principalId: string;
  deploymentDomain: string;
}): Promise<WorkflowDeployConfig> {
  const outcome = await resolveOneCredential(
    args.db,
    args.tenantId,
    { providerName: LLM_PROVIDER, source: 'tenant', name: LLM_CREDENTIAL_NAME },
    null,
    null,
    LLM_DEFAULT_MODEL
  );
  if (!outcome.ok) {
    throw new Error(
      `workflow deploy: cannot resolve LLM credential "${LLM_CREDENTIAL_NAME}" for tenant ${args.tenantId} (${outcome.reason})`
    );
  }

  const deploymentId = generateId('session');
  return {
    deploymentId,
    config: {
      sessionId: generateId('session'),
      agentId: deploymentId,
      tenantId: args.tenantId,
      principalId: args.principalId,
      agentAddress: `${deploymentId}@${args.deploymentDomain}`,
      systemPrompt: '',
      tools: [],
      grants: [],
      sources: [outcome.source],
      defaultSource: outcome.source.id,
    },
    deployContent: { systemPrompt: '' },
  };
}
