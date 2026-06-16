export type PresentationTemplateStepArgs = {
  workflowId: string;
  step: "template";
  templateId: string;
  audience?: string;
  tone?: string;
  goal?: string;
};

export type PresentationSourceStepArgs = {
  workflowId: string;
  step: "source";
  transcriptSource: "paste" | "granola" | "artifact";
  transcript?: string;
  granolaId?: string;
  sourceArtifactId?: string;
  callTitle?: string;
};

export type PresentationStepArgs =
  | PresentationTemplateStepArgs
  | PresentationSourceStepArgs;

export interface PresentationSourceData {
  source: "paste" | "granola" | "artifact";
  transcript?: string;
  granolaId?: string;
  sourceArtifactId?: string;
  callTitle?: string;
}
