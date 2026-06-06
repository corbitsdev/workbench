import type { CredentialRequirementSource } from '@intx/types';

export type WorkflowCredentialRequirement = {
  providerName: string;
  scopes?: string[];
  source: CredentialRequirementSource;
  name?: string;
};

export type WorkflowType = {
  kind: string;
  name: string;
  description: string;
  credentialRequirements: WorkflowCredentialRequirement[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

export type UserContext = {
  tenantId: string;
  principalId: string;
};
