import { type } from 'arktype';
import { HorizontalStepper, type WorkflowPanelProps, type WorkflowStep } from '@workbench/ui';
import type { StepPhase } from '@intx/workflow';

const STEP_DEFS = [
  { id: 'intake', label: 'Intake' },
  { id: 'analyze', label: 'Analyze' },
  { id: 'review', label: 'Review' },
  { id: 'scan', label: 'Scan' },
] as const;

const REVIEW_SIGNAL = 'recommendation-review';

const AnalyzeOutput = type({
  'sells?': 'string',
  'keywords?': 'string[]',
  'subreddits?': 'string[]',
  'audience?': 'string[]',
});

const Opportunity = type({
  title: 'string',
  'url?': 'string',
  'subreddit?': 'string',
  'score?': 'number',
  'reason?': 'string',
});

const ScanOutput = type({
  'opportunities?': Opportunity.array(),
});

function stepStatus(phase: StepPhase | undefined, isCurrent: boolean): WorkflowStep['status'] {
  if (phase === 'completed') {
    return 'completed';
  }
  if (isCurrent) {
    return 'current';
  }
  return 'pending';
}

function buildSteps(phaseFor: (id: string) => StepPhase | undefined): WorkflowStep[] {
  const firstIncomplete = STEP_DEFS.findIndex((s) => phaseFor(s.id) !== 'completed');
  return STEP_DEFS.map((s, index) => ({
    number: index + 1,
    label: s.label,
    status: stepStatus(phaseFor(s.id), index === firstIncomplete),
  }));
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      className="grid h-[28px] w-[28px] place-items-center rounded-[8px] border border-border text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  );
}

function Chips({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-3">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded-[8px] border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-2"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Panel({ state, connected, stepOutputs, onSignal, onClose }: WorkflowPanelProps) {
  const phaseFor = (id: string): StepPhase | undefined => state?.steps.get(id)?.phase;
  const steps = buildSteps(phaseFor);

  const analyze = AnalyzeOutput(stepOutputs.analyze);
  const analyzeView = analyze instanceof type.errors ? null : analyze;

  const scan = ScanOutput(stepOutputs.scan);
  const opportunities = scan instanceof type.errors ? [] : (scan.opportunities ?? []);

  const reviewPhase = phaseFor('review');
  const awaitingReview = reviewPhase === 'awaiting-signal';

  const connectionLabel = connected ? 'Live' : 'Reconnecting';

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-panel border border-border bg-bg">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-text">Reddit Opportunity Scanner</p>
          <p className="mt-px font-mono text-[11px] text-text-3">Scan · {connectionLabel}</p>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      <HorizontalStepper steps={steps} />

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {analyzeView ? (
            <div className="space-y-3 rounded-[10px] border border-border bg-surface px-4 py-3">
              <div className="space-y-1">
                <p className="text-[13px] font-medium text-text">Business analysis</p>
                {analyzeView.sells ? (
                  <p className="text-[12px] text-text-3">{analyzeView.sells}</p>
                ) : null}
              </div>
              <Chips label="Keywords" items={analyzeView.keywords ?? []} />
              <Chips label="Subreddits" items={analyzeView.subreddits ?? []} />
              <Chips label="Audience" items={analyzeView.audience ?? []} />
            </div>
          ) : (
            <div className="rounded-[10px] border border-border bg-surface px-4 py-3">
              <p className="text-[13px] font-medium text-text">Analyzing the site</p>
              <p className="mt-1 text-[12px] text-text-3">
                Inferring keywords, subreddits, and audience signals.
              </p>
            </div>
          )}

          {opportunities.length > 0 ? (
            <div className="space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-text-3">
                Ranked opportunities
              </p>
              {opportunities.map((opp, index) => (
                <div
                  key={`${opp.url ?? opp.title}-${index}`}
                  className="rounded-[10px] border border-border bg-surface px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-text">{opp.title}</p>
                      {opp.subreddit ? (
                        <p className="mt-px font-mono text-[11px] text-text-3">r/{opp.subreddit}</p>
                      ) : null}
                    </div>
                    {typeof opp.score === 'number' ? (
                      <span className="shrink-0 rounded-[8px] bg-orange/10 px-2 py-1 font-mono text-[12px] text-orange">
                        {opp.score}
                      </span>
                    ) : null}
                  </div>
                  {opp.reason ? (
                    <p className="mt-1.5 text-[12px] text-text-2">{opp.reason}</p>
                  ) : null}
                  {opp.url ? (
                    <a
                      href={opp.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1.5 inline-block text-[12px] text-orange hover:underline"
                    >
                      Open thread
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {awaitingReview ? (
          <div className="shrink-0 space-y-2 border-t border-border bg-surface px-4 py-3">
            <p className="text-[12px] text-text-3">
              Approve the inferred keywords and subreddits to start the Reddit scan.
            </p>
            <button
              type="button"
              onClick={() => onSignal(REVIEW_SIGNAL, { approved: true })}
              className="btn-primary w-full"
            >
              Approve and scan
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
