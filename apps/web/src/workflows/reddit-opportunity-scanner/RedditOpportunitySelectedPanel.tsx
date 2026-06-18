import { useEffect, useMemo, useState } from 'react';
import {
  useWorkflow,
  useRunStep,
  useUpdateRedditScanReview,
  useUpdateRedditOpportunityStatus,
  type FrontendWorkflowState,
} from '../../hooks/use-workflow';
import RedditOpportunityBody from '../../components/RedditOpportunityBody';
import {
  parseRedditOpportunityScan,
  type RedditOpportunityScan,
} from '../../components/RedditOpportunityBody';
import { RedditOpportunityReviewForm } from './RedditOpportunityReviewForm';
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

function redditScanData(workflow: FrontendWorkflowState | undefined): {
  scan: ReturnType<typeof parseRedditOpportunityScan>;
  artifactId?: string;
} {
  if (!workflow) return { scan: null };
  const output = (workflow as Record<string, unknown>)?.output;
  if (output && typeof output === 'object') {
    return { scan: parseRedditOpportunityScan(output) };
  }

  const scanStep = (workflow as Record<string, unknown>)?.steps?.scan as
    | { artifact?: unknown; artifactId?: string }
    | undefined;
  if (scanStep?.artifact) {
    return {
      scan: parseRedditOpportunityScan(scanStep.artifact),
      artifactId: scanStep.artifactId,
    };
  }

  const reviewStep = (workflow as Record<string, unknown>)?.steps?.review as
    | { artifact?: unknown; artifactId?: string }
    | undefined;
  if (reviewStep?.artifact) {
    return {
      scan: parseRedditOpportunityScan(reviewStep.artifact),
      artifactId: reviewStep.artifactId,
    };
  }
  return { scan: null };
}

function scanProgressMessage(scan: RedditOpportunityScan): string {
  const keywords = scan.recommendations.keywords.filter((k) => k.source !== 'rejected').length;
  const subreddits = scan.recommendations.subreddits.filter((s) => s.source !== 'rejected').length;
  return `Searching Reddit for ${keywords} keyword${keywords === 1 ? '' : 's'} across ${subreddits} subreddit${subreddits === 1 ? '' : 's'} (${scan.scanConfig.timeWindow} window)…`;
}

export function RedditOpportunitySelectedPanel({
  workflowId,
  onClose,
}: WorkflowSelectedPanelProps) {
  const { data: workflow, isLoading, isError } = useWorkflow(workflowId);
  const runStep = useRunStep(workflowId);
  const updateReview = useUpdateRedditScanReview(workflowId);
  const updateOpportunityStatus = useUpdateRedditOpportunityStatus(workflowId);
  const [stepError, setStepError] = useState<string | null>(null);
  const [reviewDraft, setReviewDraft] = useState<RedditOpportunityScan | null>(null);

  const steps = useMemo(() => {
    if (!workflow) return [];
    return buildRedditSteps(workflow.currentStep, workflow.status);
  }, [workflow]);

  const { scan: scanData, artifactId } = useMemo(() => redditScanData(workflow), [workflow]);

  useEffect(() => {
    if (workflow?.status === 'reviewing' && scanData) {
      setReviewDraft(scanData);
    }
  }, [workflow?.status, scanData]);

  const title =
    (workflow?.input as Record<string, unknown> | undefined)?.inputUrl ??
    'Reddit Opportunity Scanner';

  const isScanning =
    workflow?.status === 'ready' ||
    workflow?.status === 'running' ||
    workflow?.status === 'generating';

  const isBusy =
    runStep.isPending || updateReview.isPending || workflow?.status === 'analyzing' || isScanning;

  const handleAnalyze = () => {
    setStepError(null);
    runStep.mutate(
      { step: 'analyze' },
      {
        onError: (err) => setStepError(err instanceof Error ? err.message : 'Analysis failed'),
      }
    );
  };

  const handleSaveReview = () => {
    if (!artifactId || !reviewDraft) return;
    setStepError(null);
    updateReview.mutate(
      {
        artifactId,
        recommendations: reviewDraft.recommendations,
        scanConfig: reviewDraft.scanConfig,
      },
      {
        onError: (err) =>
          setStepError(err instanceof Error ? err.message : 'Could not save review'),
      }
    );
  };

  const handleScan = () => {
    setStepError(null);
    const saveThenScan = () => {
      runStep.mutate(
        { step: 'scan' },
        {
          onError: (err) => setStepError(err instanceof Error ? err.message : 'Scan failed'),
        }
      );
    };

    if (artifactId && reviewDraft) {
      updateReview.mutate(
        {
          artifactId,
          recommendations: reviewDraft.recommendations,
          scanConfig: reviewDraft.scanConfig,
        },
        {
          onSuccess: saveThenScan,
          onError: (err) =>
            setStepError(err instanceof Error ? err.message : 'Could not save review before scan'),
        }
      );
      return;
    }
    saveThenScan();
  };

  const handleStatusChange = (opportunityId: string, status: string) => {
    if (!artifactId) return;
    updateOpportunityStatus.mutate({ artifactId, opportunityId, status });
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
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-surface shrink-0">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-text">{title as string}</p>
          <p className="text-[11px] text-text-3 font-mono mt-px">
            {STEP_LABELS[workflow.currentStep] ?? workflow.currentStep} · {workflow.status}
          </p>
        </div>
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

      <HorizontalStepper steps={steps} />

      <div className="flex flex-1 flex-col overflow-hidden">
        {(workflow.status === 'pending' || workflow.status === 'failed') && (
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <p className="text-[13px] text-text-2">
              Ready to analyze <strong>{title as string}</strong>. We will crawl the site with
              Firecrawl and infer keywords, competitors, and subreddit recommendations.
            </p>
            {workflow.errorMessage && (
              <p className="text-[12px] text-orange-deep">{workflow.errorMessage}</p>
            )}
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

        {workflow.status === 'analyzing' && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-[13px] text-text-3">
              Crawling the site and running business analysis…
            </p>
          </div>
        )}

        {workflow.status === 'reviewing' && reviewDraft && (
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <p className="text-[13px] text-text-2">
              Review inferred recommendations, adjust scan settings, then start the Reddit search.
            </p>
            {workflow.errorMessage && (
              <p className="text-[12px] text-orange-deep">{workflow.errorMessage}</p>
            )}
            <RedditOpportunityBody scan={reviewDraft} />
            <RedditOpportunityReviewForm scan={reviewDraft} onChange={setReviewDraft} />
            {stepError && <p className="text-[12px] text-orange-deep">{stepError}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={isBusy || !artifactId}
                onClick={handleSaveReview}
                className="flex-1 rounded-lg border border-border px-3 py-2 text-[13px] text-text hover:bg-surface-2 disabled:opacity-50"
              >
                Save review
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={handleScan}
                className="flex-1 btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isBusy ? 'Scanning Reddit…' : 'Start Reddit scan'}
              </button>
            </div>
          </div>
        )}

        {isScanning && (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 px-5 text-center">
            <p className="text-[13px] text-text-2 font-medium">Reddit scan in progress</p>
            <p className="text-[13px] text-text-3">
              {scanData
                ? scanProgressMessage(scanData)
                : 'Searching Reddit and scoring opportunities…'}
            </p>
          </div>
        )}

        {workflow.status === 'done' && (
          <div className="flex-1 overflow-y-auto p-5 space-y-3">
            {workflow.errorMessage && (
              <p className="text-[12px] text-orange-deep">{workflow.errorMessage}</p>
            )}
            {scanData ? (
              <RedditOpportunityBody
                scan={scanData}
                mode="results"
                editableStatuses
                onStatusChange={handleStatusChange}
              />
            ) : (
              <p className="text-sm text-text-3">No scan results available.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
