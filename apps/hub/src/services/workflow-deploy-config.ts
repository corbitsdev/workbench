import { generateId } from '@intx/hub-common';
import { resolveCredentialRequirement, schema as intxSchema } from '@intx/db';
import { type } from 'arktype';
import { eq } from 'drizzle-orm';
import type { HarnessConfig, InferenceSource } from '@intx/types/runtime';
import type { DeployContent } from '@intx/hub-sessions';
import { LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';
import type { HubDb } from '../db';

const LLM_PROVIDER = 'openai-compatible';

const ProviderMetadata = type({ baseURL: 'string' });

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
  const credentialRow = await resolveCredentialRequirement(
    args.db,
    args.tenantId,
    { providerName: LLM_PROVIDER, source: 'tenant', name: LLM_CREDENTIAL_NAME },
    null,
    null
  );
  if (credentialRow === null) {
    throw new Error(
      `workflow deploy: cannot resolve LLM credential "${LLM_CREDENTIAL_NAME}" for tenant ${args.tenantId}`
    );
  }

  const providerRow = await args.db.query.provider.findFirst({
    where: eq(intxSchema.provider.id, credentialRow.providerId),
  });
  if (!providerRow) {
    throw new Error(
      `workflow deploy: provider ${credentialRow.providerId} for LLM credential "${LLM_CREDENTIAL_NAME}" not found in tenant ${args.tenantId}`
    );
  }

  const metadata = ProviderMetadata(providerRow.metadata ?? {});
  if (metadata instanceof type.errors) {
    throw new Error(
      `workflow deploy: provider "${providerRow.name}" is misconfigured: ${metadata.summary}`
    );
  }

  const source: InferenceSource = {
    id: `${providerRow.plugin}:${LLM_DEFAULT_MODEL}`,
    provider: providerRow.plugin,
    baseURL: metadata.baseURL,
    apiKey: credentialRow.secret,
    model: LLM_DEFAULT_MODEL,
  };

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
      sources: [source],
      defaultSource: source.id,
    },
    deployContent: { systemPrompt: '' },
  };
}
