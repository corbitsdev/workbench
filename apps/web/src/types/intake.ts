export interface IntakeRequest {
  transcript?: string;
  granolaId?: string;
  source: 'paste' | 'granola';
}

export interface IntakeResponse {
  sessionId: string;
  transcriptId: string;
  status: string;
}

export interface GranolaNote {
  id: string;
  title: string;
  created_at: string;
  participants?: string[];
  transcript?: string;
}
