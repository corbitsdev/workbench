/**
 * Workflow VIEW types — presentation shapes only.
 *
 * These describe how a workflow's progress is rendered, not how it is
 * persisted or executed. No data fetching, router, or auth concerns belong
 * here. Components in this package are stateless: current step and status
 * arrive via props.
 */

/** Display status of a single step in the stepper / sidebar. */
export type StepStatus = 'completed' | 'current' | 'pending';

/** A single step descriptor for the stepper and sidebar views. */
export interface Step {
  number: number;
  label: string;
  status: StepStatus;
}

/** Canonical workflow step identifiers used to build the step list. */
export type StepName = 'intake' | 'analyze' | 'generate' | 'approve';

/** Status of the progress checklist (e.g. live analysis tasks). */
export type ProgressStatus = 'idle' | 'running' | 'completed' | 'error';
