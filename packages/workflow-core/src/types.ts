import type { CredentialRequirementSource } from '@intx/types';

export type WorkflowCredentialRequirement = {
  providerName: string;
  scopes?: string[];
  source: CredentialRequirementSource;
  name?: string;
};

export type WorkflowStepDefinition = {
  /** Step identifier; matches the hub's step ordering (e.g. 'intake', 'analyze'). */
  name: string;
  label: string;
  description?: string;
  /** Credentials this step needs (inference, granola, ...). Empty for steps that need none. */
  credentialRequirements: WorkflowCredentialRequirement[];
  /** Tool names (from the hub tool registry) this step may use. */
  tools?: string[];
};

export type WorkflowType = {
  kind: string;
  name: string;
  description: string;
  steps: WorkflowStepDefinition[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

/**
 * Flatten every step's credential requirements into a single list, de-duplicated
 * by providerName + name. Lets callers that want a workflow-wide view derive it
 * from the per-step declarations rather than maintaining a separate field.
 */
export function flattenStepCredentialRequirements(
  workflow: WorkflowType
): WorkflowCredentialRequirement[] {
  const seen = new Set<string>();
  const result: WorkflowCredentialRequirement[] = [];
  for (const step of workflow.steps) {
    for (const req of step.credentialRequirements) {
      const key = `${req.providerName}::${req.name ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(req);
    }
  }
  return result;
}

export type UserContext = {
  tenantId: string;
  principalId: string;
};
