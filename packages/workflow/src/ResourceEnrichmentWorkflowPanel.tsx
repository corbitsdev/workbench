import { useState, type ReactNode } from 'react';
import HorizontalStepper from './HorizontalStepper';
import type { Step } from './types';

// Invariant: this component ALWAYS renders a body. There is no status for
// which it shows an empty pane.

export interface ResourceEnrichmentArtifactView {
  id: string;
  title: string;
  content: string;
  kind: string;
}

export interface ResourceEnrichmentStepView {
  completed?: boolean;
  rows?: number;
  selections?: ResourceEnrichmentArtifactView[];
  artifacts?: ResourceEnrichmentArtifactView[];
  [key: string]: unknown;
}

export interface ResourceEnrichmentWorkflowView {
  status: string;
  companyName?: string | null;
  steps?: Record<string, ResourceEnrichmentStepView> | null;
  errorMessage?: string | null;
}

export interface ResourceEnrichmentWorkflowPanelProps {
  workflow: ResourceEnrichmentWorkflowView | null | undefined;
  isLoading?: boolean;
  isError?: boolean;
  title?: string;
  onClose: () => void;
  onEnrich?: () => void;
  onExport?: () => void;
  isEnrichPending?: boolean;
  isExportPending?: boolean;
  /** When true during review, shows the export action (partial exports are allowed). */
  canExport?: boolean;
  stepError?: string | null;
  renderSelection?: (artifact: ResourceEnrichmentArtifactView) => ReactNode;
  renderCsvDownload?: (artifact: ResourceEnrichmentArtifactView) => ReactNode;
}

const RESOURCE_STEPS = [
  { name: 'intake', label: 'Intake' },
  { name: 'enrich', label: 'Enrich' },
  { name: 'review', label: 'Review' },
  { name: 'export', label: 'Export' },
] as const;

function buildResourceSteps(steps: Record<string, ResourceEnrichmentStepView>): Step[] {
  const firstIncomplete = RESOURCE_STEPS.findIndex((s) => !steps[s.name]?.completed);
  return RESOURCE_STEPS.map((step, index) => {
    let status: Step['status'];
    if (steps[step.name]?.completed) {
      status = 'completed';
    } else if (index === firstIncomplete) {
      status = 'current';
    } else {
      status = 'pending';
    }
    return { number: index + 1, label: step.label, status };
  });
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      className="grid h-[28px] w-[28px] place-items-center rounded-[8px] border border-border text-text-2 hover:text-text hover:bg-surface-2 transition-colors"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="h-4 w-4"
      >
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  );
}

function StatusBody({
  status,
  rowCount,
  selectionCount,
  errorMessage,
}: {
  status: string;
  rowCount?: number;
  selectionCount?: number;
  errorMessage?: string | null;
}) {
  if (status === 'generating') {
    return (
      <div className="rounded-[10px] border border-border bg-surface px-4 py-3 space-y-1">
        <p className="text-[13px] font-medium text-text">Enriching products</p>
        <p className="text-[12px] text-text-3">
          Generating SEO titles, descriptions, and summaries for each row.
        </p>
      </div>
    );
  }
  if (status === 'ready' || status === 'running') {
    return (
      <div className="rounded-[10px] border border-border bg-surface px-4 py-3 space-y-1">
        <p className="text-[13px] font-medium text-text">Catalog parsed</p>
        <p className="text-[12px] text-text-3">
          {rowCount !== undefined
            ? `${rowCount} row${rowCount === 1 ? '' : 's'} ready for enrichment.`
            : 'Ready to start enrichment.'}
        </p>
      </div>
    );
  }
  if (status === 'reviewing') {
    return (
      <div className="rounded-[10px] border border-border bg-surface px-4 py-3 space-y-1">
        <p className="text-[13px] font-medium text-text">Review selections</p>
        <p className="text-[12px] text-text-3">
          {selectionCount !== undefined
            ? `Pick one option per field for each of ${selectionCount} product${selectionCount === 1 ? '' : 's'}.`
            : 'Pick one option per field for each product.'}
        </p>
      </div>
    );
  }
  if (status === 'done') {
    return (
      <div className="rounded-[10px] border border-border bg-surface px-4 py-3 space-y-1">
        <p className="text-[13px] font-medium text-text">Export ready</p>
        <p className="text-[12px] text-text-3">Your enriched catalog CSV is ready to download.</p>
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div className="rounded-[10px] border border-orange/40 bg-orange/5 px-4 py-3">
        <p className="text-[13px] font-medium text-text">Enrichment failed</p>
        <p className="text-[12px] text-text-3 mt-1">
          {errorMessage ?? 'The workflow could not complete. Try again.'}
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-[10px] border border-border bg-surface px-4 py-3">
      <p className="text-[13px] font-medium text-text">Preparing workflow</p>
      <p className="text-[12px] text-text-3 mt-1">Upload received. Parsing will begin shortly.</p>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  ready: 'Ready',
  running: 'Ready',
  generating: 'Enriching',
  reviewing: 'Reviewing',
  done: 'Done',
  failed: 'Failed',
};

export function ResourceEnrichmentWorkflowPanel({
  workflow,
  isLoading,
  isError,
  title,
  onClose,
  onEnrich,
  onExport,
  isEnrichPending = false,
  isExportPending = false,
  canExport = false,
  stepError = null,
  renderSelection,
  renderCsvDownload,
}: ResourceEnrichmentWorkflowPanelProps) {
  const [activeSelectionIndex, setActiveSelectionIndex] = useState(0);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center rounded-panel border border-border bg-bg">
        <p className="text-[13px] text-text-3">Loading workflow…</p>
      </div>
    );
  }

  if (isError || !workflow) {
    return (
      <div className="flex h-full flex-col rounded-panel border border-border bg-bg">
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-surface shrink-0">
          <p className="text-[14px] font-semibold text-text">{title ?? 'Resource enrichment'}</p>
          <CloseButton onClose={onClose} />
        </div>
        <div className="flex flex-1 items-center justify-center p-5">
          <p className="text-[13px] text-text-3">Could not load this workflow.</p>
        </div>
      </div>
    );
  }

  const steps = workflow.steps ?? {};
  const stepperSteps = buildResourceSteps(steps);
  const intake = steps.intake ?? {};
  const enrich = steps.enrich ?? {};
  const review = steps.review ?? {};
  const exportStep = steps.export ?? {};
  const selections = enrich.selections ?? [];
  const currentSelectionIndex = Math.min(activeSelectionIndex, Math.max(selections.length - 1, 0));
  const activeSelection = selections[currentSelectionIndex];
  const csvArtifacts = exportStep.artifacts ?? [];
  const displayTitle = title ?? workflow.companyName ?? 'Resource enrichment';
  const statusLabel = STATUS_LABELS[workflow.status] ?? workflow.status;
  const rowCount = typeof intake.rows === 'number' ? intake.rows : undefined;
  const canStartEnrich =
    Boolean(intake.completed) && !enrich.completed && workflow.status !== 'generating';

  return (
    <div className="relative flex flex-col h-full overflow-hidden rounded-panel border border-border bg-bg">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-surface shrink-0">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-text">{displayTitle}</p>
          <p className="text-[11px] text-text-3 font-mono mt-px">Enrich · {statusLabel}</p>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      <HorizontalStepper steps={stepperSteps} />

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <StatusBody
            status={workflow.status}
            {...(rowCount !== undefined ? { rowCount } : {})}
            {...(selections.length > 0 ? { selectionCount: selections.length } : {})}
            {...(workflow.errorMessage ? { errorMessage: workflow.errorMessage } : {})}
          />

          {workflow.status === 'reviewing' && activeSelection && renderSelection && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border bg-surface px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-text">{activeSelection.title}</p>
                  <p className="text-[12px] text-text-3">
                    Row {currentSelectionIndex + 1} of {selections.length}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveSelectionIndex(Math.max(0, currentSelectionIndex - 1))}
                    disabled={currentSelectionIndex === 0}
                    className="rounded border border-border px-3 py-1.5 text-xs font-medium text-text-2 disabled:opacity-50"
                  >
                    Previous row
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setActiveSelectionIndex(Math.min(selections.length - 1, currentSelectionIndex + 1))
                    }
                    disabled={currentSelectionIndex >= selections.length - 1}
                    className="rounded border border-border px-3 py-1.5 text-xs font-medium text-text-2 disabled:opacity-50"
                  >
                    Next row
                  </button>
                </div>
              </div>
              <div
                key={activeSelection.id}
                className="rounded-[10px] border border-border bg-surface p-4"
              >
                {renderSelection(activeSelection)}
              </div>
            </div>
          )}

          {workflow.status === 'done' && csvArtifacts.length > 0 && renderCsvDownload && (
            <div className="space-y-3">
              {csvArtifacts.map((artifact) => (
                <div key={artifact.id}>{renderCsvDownload(artifact)}</div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-border bg-surface px-4 py-3 shrink-0 space-y-2">
          {canStartEnrich && onEnrich && (
            <button
              type="button"
              onClick={onEnrich}
              disabled={isEnrichPending}
              className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isEnrichPending ? 'Starting enrichment…' : 'Start enrichment'}
            </button>
          )}
          {workflow.status === 'generating' && (
            <button type="button" disabled className="btn-primary w-full">
              Enriching…
            </button>
          )}
          {workflow.status === 'reviewing' && canExport && onExport && (
            <button
              type="button"
              onClick={onExport}
              disabled={isExportPending}
              className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isExportPending ? 'Exporting…' : 'Export CSV'}
            </button>
          )}
          {stepError && <p className="text-[12px] text-orange">{stepError}</p>}
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-[9px] border border-border bg-surface-2 px-3 py-2 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text active:scale-[0.97]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}