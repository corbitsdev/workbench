export type Severity = "low" | "medium" | "high" | "critical";

export type SessionStatus =
  | "analyzing"
  | "reviewing"
  | "generating"
  | "improving"
  | "exporting"
  | "done";

export type CollateralType = "email" | "linkedin" | "one-pager" | "battlecard";

export type CollateralStatus = "draft" | "approved" | "rejected";

export interface PainPoint {
  id: string;
  sessionId: string;
  severity: Severity;
  context: string;
  quote: string;
  selected: boolean;
  createdAt: string;
}

export interface CollateralItem {
  id: string;
  painPointId: string;
  type: CollateralType;
  title: string;
  body: string;
  status: CollateralStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollateralVersion {
  id: string;
  collateralId: string;
  title: string;
  body: string;
  version: number;
  createdAt: string;
}

export interface TranscriptInput {
  transcript: string;
  source?: "paste" | "granola";
}

export interface WorkbenchSession {
  id: string;
  transcriptId: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyzeRequest {
  transcript: string;
}

export interface AnalyzeResponse {
  sessionId: string;
  painPoints: PainPoint[];
  status: SessionStatus;
}

export interface GenerateRequest {
  sessionId: string;
  painPointIds: string[];
}

export interface GenerateResponse {
  collateral: CollateralItem[];
  status: SessionStatus;
}

export interface ImproveRequest {
  collateralId: string;
  feedback: string;
}

export interface ImproveResponse {
  collateral: CollateralItem;
  status: SessionStatus;
}
