import { useMemo, useState } from 'react';
import {
  useWorkflow,
  useRunStep,
  type FrontendWorkflowState,
} from '../../hooks/use-workflow';
import RedditOpportunityBody from '../../components/RedditOpportunityBody';
import { parseRedditOpportunityScan } from '../../components/RedditOpportunityBody';
import { HorizontalStepper } from '@workbench/workflow';
import type { Step } from '@workbench/workflow';
import type { WorkflowSelectedPanelProps } from '../registry';

const STEP_LABELS: Record<string, string> = {
  intake: 'Start Scan',
  analyze: 'Business Summary',
  review: 'Recommendation Review',
  scan: 'Reddit Scan',
};

function buildRedditSteps(currentStep: string, status: string): Step[] {
  const order = ['intake', 'analyze', 'review', 'scan'];
  const currentIndex = order.indexOf(currentStep);
  return order.map((name, index) => {
    let stepStatus: Step['status'];
    if (status === 'done' || index < currentIndex) {
      stepStatus = 'completed';
    } else if (index === currentIndex) {
      stepStatus = 'current';
    } else {
      stepStatus = 'pending';
    }
    return {
      number: index + 1,
      label: STEP_LABELS[name] ?? name,
      status: stepStatus,
    };
  });
}

function redditScanData(
  workflow: FrontendWorkflowState | undefined
): ReturnType<typeof parseRedditOpportunityScan> {
  if (!workflow) return null;
  const output = (workflow as Record<string, unknown>)?.output;
  if (output && typeof output === 'object') {
    return parseRedditOpportunityScan(output);
  }
  // During reviewing the draft artifact lives in the review step.
  const reviewStep = (workflow as Record<string, unknown>)?.steps?.review as
    | { artifact?: unknown }
    | undefined;
  if (reviewStep?.artifact) {
    return parseRedditOpportunityScan(reviewStep.artifact);
  }
  // When done the final artifact lives in the scan step.
  const scanStep = (workflow as Record<string, unknown>)?.steps?.scan as
    | { artifact?: unknown }
    | undefined;
  if (scanStep?.artifact) {
    return parseRedditOpportunityScan(scanStep.artifact);
  }
  return null;
}

export function RedditOpportunitySelectedPanel({
  workflowId,
  onClose,
}: WorkflowSelectedPanelProps) {
  const { data: workflow, isLoading, isError } = useWorkflow(workflowId);
  const runStep = useRunStep(workflowId);
  const [stepError, setStepError] = useState<string | null>(null);

  const steps = useMemo(() => {
    if (!workflow) return [];
    return buildRedditSteps(workflow.currentStep, workflow.status);
  }, [workflow]);

  const scanData = useMemo(() => redditScanData(workflow), [workflow]);

  const title =
    (workflow?.input as Record<string, unknown> | undefined)?.inputUrl ?? 'Reddit Opportunity Scanner';

  const isBusy = runStep.isPending || workflow?.status === 'analyzing' || workflow?.status === 'running' || workflow?.status === 'generating';

  const handleAnalyze = () => {
    setStepError(null);
    runStep.mutate(
      { step: 'analyze' },
      {
        onError: (err) =>
          setStepError(err instanceof Error ? err.message : 'Analysis failed'),
      }
    );
  };

  const handleScan = () => {
    setStepError(null);
    runStep.mutate(
      { step: 'scan' },
      {
        onError: (err) =>
          setStepError(err instanceof Error ? err.message : 'Scan failed'),
      }
    );
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-text-3">Loading workflow…</p>
      </div>
    );
  }

  if (isError || !workflow) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-text-3">Could not load workflow.</p>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col h-full overflow-hidden rounded-panel border border-border bg-bg">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-surface shrink-0">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-text">{title as string}</p>
          <p className="text-[11px] text-text-3 font-mono mt-px">
            {STEP_LABELS[workflow.currentStep] ?? workflow.currentStep} ·{' '}
            {workflow.status}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
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
        </div>
      </div>

      {/* Step progress */}
      <HorizontalStepper steps={steps} />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Pending / failed — show analyze button */}
        {(workflow.status === 'pending' || workflow.status === 'failed') && (
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <p className="text-[13px] text-text-2">
              Ready to analyze <strong>{title as string}</strong>. Click below to start the
              business summary step.
            </p>
            {stepError && <p className="text-[12px] text-orange-deep">{stepError}</p>}
            <button
              type="button"
              disabled={isBusy}
              onClick={handleAnalyze}
              className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isBusy ? 'Analyzing…' : 'Analyze website'}
            </button>
          </div>
        )}

        {/* Analyzing — loading */}
        {workflow.status === 'analyzing' && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-[13px] text-text-3">Analyzing website content…</p>
          </div>
        )}

        {/* Reviewing — show recommendations + scan button */}
        {workflow.status === 'reviewing' && (
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <p className="text-[13px] text-text-2">
              Business summary complete. Review the recommendations below, then start the Reddit
              scan.
            </p>
            {scanData ? (
              <RedditOpportunityBody scan={scanData} />
            ) : (
              <p className="text-sm text-text-3">No recommendations available.</p>
            )}
            {stepError && <p className="text-[12px] text-orange-deep">{stepError}</p>}
            <button
              type="button"
              disabled={isBusy}
              onClick={handleScan}
              className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isBusy ? 'Scanning Reddit…' : 'Start Reddit scan'}
            </button>
          </div>
        )}

        {/* Running / generating — loading */}
        {(workflow.status === 'running' || workflow.status === 'generating') && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-[13px] text-text-3">Scanning Reddit for opportunities…</p>
          </div>
        )}

        {/* Done — show results */}
        {workflow.status === 'done' && (
          <div className="flex-1 overflow-y-auto p-5">
            {scanData ? (
              <RedditOpportunityBody scan={scanData} />
            ) : (
              <p className="text-sm text-text-3">No scan data available.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
