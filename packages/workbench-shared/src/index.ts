import { type } from 'arktype';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

// 'pending' = created, analysis not yet started.
// 'ready' = analysis complete, awaiting the user's generate selection.
// 'generating' = collateral generation actively running.
export type SessionStatus =
  | 'pending'
  | 'analyzing'
  | 'ready'
  | 'generating'
  | 'reviewing'
  | 'done'
  | 'failed';

// The subset of artifact kinds the UI knows how to render exhaustively.
// The DB `kind` column is free-form text; this union stays closed for the
// CollateralBody renderer switch.
export type ArtifactKind =
  | 'email'
  | 'linkedin-post'
  | 'twitter-post'
  | 'blog'
  | 'founder-pov-post'
  | 'one-pager'
  | 'case-study'
  | 'objection-handling'
  | 'customer-quotes'
  | 'battlecard'
  | 'pain-points'
  | 'call-transcript'
  | 'presentation';

export type ArtifactStatus = 'draft' | 'approved' | 'rejected';

export const PainPoint = type({
  id: 'string',
  workflowId: 'string',
  severity: "'low' | 'medium' | 'high' | 'critical'",
  context: 'string',
  quote: 'string',
  selected: 'boolean',
  createdAt: 'string',
});
export type PainPoint = typeof PainPoint.infer;

export const Artifact = type({
  id: 'string',
  sessionId: 'string | null',
  parentId: 'string | null',
  painPointId: 'string | null',
  kind: 'string',
  title: 'string',
  content: 'string',
  status: "'draft' | 'approved' | 'rejected'",
  version: 'number',
  ownerPrincipalId: 'string | null',
  createdAt: 'string',
  updatedAt: 'string',
  'source?': 'Record<string, unknown> | null',
});
export type Artifact = typeof Artifact.infer;

export const ArtifactVersion = type({
  id: 'string',
  artifactId: 'string',
  version: 'number',
  title: 'string',
  content: 'string',
  authorId: 'string',
  createdAt: 'string',
});
export type ArtifactVersion = typeof ArtifactVersion.infer;

/** An artifact with its full version history. */
export type ArtifactWithVersions = Artifact & { versions: ArtifactVersion[] };

/**
 * An artifact enriched with the session it belongs to. Returned by the
 * aggregate `GET /artifacts` endpoint so the library can show a "from" label
 * without a second round-trip.
 */
export type ArtifactWithSession = Artifact & {
  sessionName: string | null;
  sessionStatus: SessionStatus;
  ownerName: string | null;
};

/**
 * One row from `GET /workflow-runs` — a summary of a natively-deployed
 * workflow, used to populate the library rail. `status` is the free-form
 * `workflow_run.status` text, not a {@link SessionStatus}.
 */
export interface WorkflowSummary {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
}

export interface TranscriptInput {
  transcript: string;
  source?: 'paste' | 'granola';
}

export interface WorkbenchSession {
  id: string;
  transcriptId: string;
  status: SessionStatus;
  companyName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowState {
  id: string;
  kind: string;
  status: SessionStatus;
  currentStep: string;
  companyName: string | null;
  /**
   * Generic per-step state. Each workflow's steps carry their own
   * inputs/outputs here under the step name; the host stays domain-agnostic.
   */
  steps: Record<string, unknown>;
}

export interface AnalyzeRequest {
  transcript: string;
}

export interface AnalyzeResponse {
  workflowId: string;
  painPoints: PainPoint[];
  status: SessionStatus;
}

export interface GenerateRequest {
  workflowId: string;
  painPointIds: string[];
}

export interface GenerateResponse {
  workflowId: string;
  artifacts: Artifact[];
  status: SessionStatus;
}

export interface ImproveRequest {
  artifactId: string;
  feedback: string;
}

export interface ImproveResponse {
  artifact: Artifact;
  status: SessionStatus;
}
