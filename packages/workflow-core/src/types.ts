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

export type WorkflowArtifactDraft = {
  kind: string;
  title: string;
  content: string;
  status?: 'draft' | 'approved' | 'rejected';
  version?: number;
};

export type WorkflowOutputOption = {
  id: string;
  label: string;
};

/** Generic per-step state. `completed` is required; everything else is the
 *  step's own custom inputs/outputs, opaque to the host. */
export type WorkflowStepState = {
  completed: boolean;
  [key: string]: unknown;
};

/** Host-supplied, already-serialized run state. The workflow turns this into
 *  its own named steps — the host never hardcodes a workflow's step list. */
export type WorkflowStepStateContext = {
  /** Generic lifecycle status (pending/running/generating/reviewing/done/failed).
   *  A status label, NOT a step. */
  status: string;
  input: Record<string, unknown>;
  intakeTranscript?: { id: string | null; content?: string };
  painPoints: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown> & { kind: string; status: string }>;
};

export type WorkflowType = {
  kind: string;
  name: string;
  description: string;
  steps: WorkflowStepDefinition[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  outputOptions?: WorkflowOutputOption[];
  deriveRunTitle?: (input: Record<string, unknown> | undefined) => string | null;
  createIntakeArtifacts?: (context: {
    input: Record<string, unknown>;
    content: string;
    callTitle?: string;
  }) => WorkflowArtifactDraft[];
  createAnalyzeArtifacts?: (context: {
    input: Record<string, unknown>;
    painPoints: Array<{ severity: string; context: string; quote: string }>;
    companyName?: string | null;
  }) => WorkflowArtifactDraft[];
  selectGenerateArtifactKinds?: (requested: string[] | undefined) => string[];
  /** Build this workflow's custom, named steps from generic run state. The host
   *  serializes the raw rows and delegates here so step shapes stay in the
   *  workflow package, not the hub. */
  serializeStepState?: (context: WorkflowStepStateContext) => Record<string, WorkflowStepState>;
  /** Map a generic lifecycle status to this workflow's current step name. Owned
   *  by the workflow so the host never branches on kind to order steps. */
  deriveCurrentStep?: (status: string) => string;
  /**
   * V2 generic pipeline: artifact kinds the user may select as inputs. Undefined
   * means any tenant artifact is eligible; an empty array means none.
   */
  inputArtifactKinds?: string[];
};

/**
 * A V2 generic workflow run: the user selects N existing artifacts as inputs and
 * M output types to generate. Each output type generates independently.
 */
export type MultiIOInput = {
  inputArtifactIds: string[];
  outputTypes: string[];
};

/** The output-type ids a workflow offers (empty when it declares none). */
export function getOutputOptionIds(workflow: WorkflowType): string[] {
  return (workflow.outputOptions ?? []).map((option) => option.id);
}

/**
 * Split requested output types into those the workflow offers and those it does
 * not. Callers reject the request when `unknown` is non-empty rather than
 * silently dropping types — keep failures loud.
 */
export function partitionOutputTypes(
  workflow: WorkflowType,
  requested: string[]
): { known: string[]; unknown: string[] } {
  const offered = new Set(getOutputOptionIds(workflow));
  const known: string[] = [];
  const unknown: string[] = [];
  for (const type of requested) {
    if (offered.has(type)) {
      known.push(type);
    } else {
      unknown.push(type);
    }
  }
  return { known, unknown };
}

/**
 * Validate a multi-input/multi-output run request against a workflow. Returns an
 * error string when invalid (no inputs, no outputs, or unknown output types) so
 * the caller can fail loudly; returns null when the request is valid.
 */
export function validateMultiIOInput(workflow: WorkflowType, input: MultiIOInput): string | null {
  if (input.inputArtifactIds.length === 0) {
    return 'Select at least one input artifact';
  }
  if (input.outputTypes.length === 0) {
    return 'Select at least one output type';
  }
  const { unknown } = partitionOutputTypes(workflow, input.outputTypes);
  if (unknown.length > 0) {
    return `Unknown output type(s): ${unknown.join(', ')}`;
  }
  return null;
}

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
