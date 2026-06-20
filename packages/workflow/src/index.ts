export {
  HorizontalStepper,
  ProgressChecklist,
  StepSidebar,
  buildSteps,
  type ProgressChecklistProps,
  type WorkflowStep,
  type WorkflowStepName,
  type WorkflowStepStatus,
  type WorkflowProgressStatus,
} from '@workbench/ui';
import type {
  WorkflowStep,
  WorkflowStepName,
  WorkflowStepStatus,
  WorkflowProgressStatus,
} from '@workbench/ui';

/** @deprecated Import `WorkflowStep` from `@workbench/ui`. */
export type Step = WorkflowStep;
/** @deprecated Import `WorkflowStepName` from `@workbench/ui`. */
export type StepName = WorkflowStepName;
/** @deprecated Import `WorkflowStepStatus` from `@workbench/ui`. */
export type StepStatus = WorkflowStepStatus;
/** @deprecated Import `WorkflowProgressStatus` from `@workbench/ui`. */
export type ProgressStatus = WorkflowProgressStatus;

export {
  PresentationGenerationWizard,
  type PresentationGenerationWizardProps,
  type PresentationSourceData,
  type GammaTemplate,
} from './PresentationGenerationWizard';
export {
  PresentationWorkflowPanel,
  type PresentationWorkflowPanelProps,
  type PresentationWorkflowView,
} from './PresentationWorkflowPanel';
export {
  ResourceEnrichmentWorkflowPanel,
  type ResourceEnrichmentWorkflowPanelProps,
  type ResourceEnrichmentWorkflowView,
  type ResourceEnrichmentArtifactView,
} from './ResourceEnrichmentWorkflowPanel';
export type {
  PresentationStepArgs,
  PresentationTemplateStepArgs,
  PresentationSourceStepArgs,
} from './presentation-wizard-types';
