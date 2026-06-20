import type { ComponentType } from 'react';
import type { IntakeFormProps } from '../workflows/registry';

export type WorkflowUIModule = {
  IntakeForm?: ComponentType<IntakeFormProps>;
  label?: string;
};

// Maps kind → lazy importer. Add one entry when a new workflow package is added.
// Vite code-splits each entry into its own chunk; only the opened workflow loads.
const importers: Record<string, () => Promise<WorkflowUIModule>> = {
  'collateral-generation': () => import('@workbench/workflow-collateral-generation'),
  'gamma-presentation-creator': () => import('@workbench/workflow-gamma-presentation-creator'),
  'seo-enrichment': () => import('@workbench/workflow-seo-enrichment'),
  'ab-compare': () => import('@workbench/workflow-ab-compare'),
  'reddit-opportunity-scanner': () => import('@workbench/workflow-reddit-opportunity-scanner'),
};

export async function loadWorkflowUI(kind: string): Promise<WorkflowUIModule | null> {
  const load = importers[kind];
  if (!load) return null;
  return load();
}
