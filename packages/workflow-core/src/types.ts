import type { CredentialRequirement } from '@intx/types';

export type WorkflowType = {
  kind: string;
  name: string;
  description: string;
  credentialRequirements: CredentialRequirement[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

export type UserContext = {
  tenantId: string;
  principalId: string;
};
