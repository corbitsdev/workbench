export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type SessionStatus =
  | 'analyzing'
  | 'reviewing'
  | 'generating'
  | 'improving'
  | 'exporting'
  | 'done';

// The subset of artifact kinds the UI knows how to render exhaustively.
// The DB `kind` column is free-form text; this union stays closed for the
// CollateralBody renderer switch.
export type ArtifactKind = 'email' | 'linkedin' | 'one-pager' | 'battlecard';

export type ArtifactStatus = 'draft' | 'approved' | 'rejected';

export interface PainPoint {
  id: string;
  workflowId: string;
  severity: Severity;
  context: string;
  quote: string;
  selected: boolean;
  createdAt: string;
}

export interface Artifact {
  id: string;
  sessionId: string;
  parentId: string | null;
  painPointId: string | null;
  kind: ArtifactKind;
  title: string;
  content: string;
  status: ArtifactStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactVersion {
  id: string;
  artifactId: string;
  version: number;
  title: string;
  content: string;
  authorId: string;
  createdAt: string;
}

/**
 * An artifact enriched with the session it belongs to. Returned by the
 * aggregate `GET /artifacts` endpoint so the library can show a "from" label
 * without a second round-trip.
 */
export interface ArtifactWithSession extends Artifact {
  sessionName: string | null;
  sessionStatus: SessionStatus;
}

/**
 * One row from `GET /workflows` — a summary of a user's session, used to
 * populate the library rail.
 */
export interface WorkflowSummary {
  id: string;
  status: SessionStatus;
  createdAt: string;
  transcriptId: string;
  companyName: string | null;
  transcriptPreview: string | null;
  painPointCount: number;
  firstPainPoint: string | null;
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
  status: SessionStatus;
  currentStep: string;
  companyName: string | null;
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

// ─── Collateral Generation Workflow ──────────────────────────────────

export type OutputType = 'case-study' | 'one-pager' | 'email-draft';

export type CollateralGenerationStatus = 'pending' | 'generating' | 'done' | 'failed';

export type GeneratedArtifactStatus = 'pending' | 'generating' | 'done' | 'failed';

export interface GeneratedArtifact {
  id: string;
  workflowId: string;
  kind: OutputType;
  title: string;
  body: string;
  status: GeneratedArtifactStatus;
  inputArtifactIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface OutputState {
  status: GeneratedArtifactStatus;
  artifactId?: string;
  title?: string;
}

export interface CollateralGenerationWorkflow {
  id: string;
  status: CollateralGenerationStatus;
  inputArtifactIds: string[];
  outputTypes: OutputType[];
  outputs: Record<OutputType, OutputState>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCollateralGenerationRequest {
  kind: 'collateral-generation';
  inputArtifactIds: string[];
  outputTypes: OutputType[];
}

export interface ArtifactsResponse {
  artifacts: GeneratedArtifact[];
}
