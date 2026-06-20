import type { ComponentType } from 'react';
import type { WorkflowPanelProps } from '@workbench/ui';

export type WorkflowUIModule = {
  label?: string;
  description?: string;
  Panel?: ComponentType<WorkflowPanelProps>;
};

// Maps kind → lazy importer. Add one entry when a new workflow package is added.
// Vite code-splits each entry into its own chunk; only the opened workflow loads.
// A workflow package exports `Panel` once it ships a custom run UI; until then the
// module resolves with `Panel` undefined and the generic RunConsole renders.
const importers: Record<string, () => Promise<WorkflowUIModule>> = {
  'ab-compare': () => import('@workbench/workflow-ab-compare'),
  'blind-ab-comparison': () => import('@workbench/workflow-blind-ab-comparison'),
  'collateral-generation': () => import('@workbench/workflow-collateral-generation'),
  'gamma-presentation-creator': () => import('@workbench/workflow-gamma-presentation-creator'),
  'pain-point-collateral': () => import('@workbench/workflow-pain-point-collateral'),
  'presentation-generation': () => import('@workbench/workflow-presentation-generation'),
  'reddit-opportunity-scanner': () => import('@workbench/workflow-reddit-opportunity-scanner'),
  'resource-enrichment': () => import('@workbench/workflow-resource-enrichment'),
  'seo-enrichment': () => import('@workbench/workflow-seo-enrichment'),
  'seo-enrichment-from-image': () => import('@workbench/workflow-seo-enrichment-from-image'),
};

export async function loadWorkflowUI(kind: string): Promise<WorkflowUIModule | null> {
  const load = importers[kind];
  if (!load) return null;
  return load();
}
