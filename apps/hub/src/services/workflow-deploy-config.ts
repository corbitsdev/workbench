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

// Resolve the tenant's shared LLM inference source. Today every native workflow
// runs on the shared tenant LLM source; per-source workflows extend this when
// they land. Split out from config assembly so a re-drive (the deployment
// reconciler / run-start resilience, CL-2224/CL-2225) can rebuild config for an
// EXISTING deploymentId without minting a new one.
export async function resolveWorkflowDeploySource(args: {
  db: HubDb;
  tenantId: string;
}): Promise<InferenceSource> {
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

  return {
    id: `${providerRow.plugin}:${LLM_DEFAULT_MODEL}`,
    provider: providerRow.plugin,
    baseURL: metadata.baseURL,
    apiKey: credentialRow.secret,
    model: LLM_DEFAULT_MODEL,
  };
}

// Assemble the base HarnessConfig from a resolved source and a caller-supplied
// deploymentId. The orchestrator overrides each step's address and prompt; the
// base only carries the tenant inference source the steps pin against. A
// re-drive passes the persisted deploymentId so derived step/supervisor
// addresses match the rows the original deploy wrote.
export function assembleWorkflowDeployConfig(args: {
  deploymentId: string;
  tenantId: string;
  principalId: string;
  deploymentDomain: string;
  source: InferenceSource;
}): WorkflowDeployConfig {
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
      sources: [args.source],
      defaultSource: args.source.id,
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
  const source = await resolveWorkflowDeploySource({
    db: args.db,
    tenantId: args.tenantId,
  });
  return assembleWorkflowDeployConfig({
    deploymentId: generateId('session'),
    tenantId: args.tenantId,
    principalId: args.principalId,
    deploymentDomain: args.deploymentDomain,
    source,
  });
}
