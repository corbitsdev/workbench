import HorizontalStepper from './HorizontalStepper';
import type { Step } from './types';

// Invariant: this component ALWAYS renders a body. There is no status for
// which it shows an empty pane.

export interface PresentationStepView {
  completed?: boolean;
  [key: string]: unknown;
}

export interface PresentationWorkflowView {
  status: string;
  companyName?: string | null;
  /** Generic per-step state, as serialized by the presentation workflow. */
  steps?: Record<string, PresentationStepView> | null;
}

export interface PresentationWorkflowPanelProps {
  workflow: PresentationWorkflowView | null | undefined;
  isLoading?: boolean;
  isError?: boolean;
  /** URL to open the generated Gamma deck. Available once status is 'done'. */
  gammaUrl?: string | null;
  onClose: () => void;
}

const PRESENTATION_STEPS = [
  { name: 'template', label: 'Template' },
  { name: 'source', label: 'Source' },
  { name: 'generate', label: 'Generate' },
] as const;

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

// Stepper state is data-driven from each step's `completed` flag — not the
// workflow status. The current step is the first one not yet completed.
function buildPresentationSteps(steps: Record<string, PresentationStepView>): Step[] {
  const firstIncomplete = PRESENTATION_STEPS.findIndex((s) => !steps[s.name]?.completed);
  return PRESENTATION_STEPS.map((step, index) => {
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

function briefRows(
  steps: Record<string, PresentationStepView>
): { label: string; value: string }[] {
  const template = steps.template ?? {};
  const source = steps.source ?? {};
  const rows: { label: string; value: string }[] = [];
  const templateId = readString(template.templateId);
  if (templateId) rows.push({ label: 'Template', value: templateId });
  const audience = readString(template.audience);
  if (audience) rows.push({ label: 'Audience', value: audience });
  const tone = readString(template.tone);
  if (tone) rows.push({ label: 'Tone', value: tone });
  const goal = readString(template.goal);
  if (goal) rows.push({ label: 'Goal', value: goal });
  const callTitle = readString(source.callTitle);
  if (callTitle) rows.push({ label: 'Source', value: callTitle });
  return rows;
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

function StatusBody({ status, gammaUrl }: { status: string; gammaUrl?: string | null }) {
  if (status === 'generating') {
    return (
      <div className="rounded-[10px] border border-border bg-surface px-4 py-3 space-y-1">
        <p className="text-[13px] font-medium text-text">Generating content from brief</p>
        <p className="text-[12px] text-text-3">
          Writing slide content from your transcript and brief.
        </p>
      </div>
    );
  }
  if (status === 'reviewing') {
    return (
      <div className="rounded-[10px] border border-border bg-surface px-4 py-3 space-y-1">
        <p className="text-[13px] font-medium text-text">Reviewing against brand guidelines</p>
        <p className="text-[12px] text-text-3">
          Checking tone, messaging, and storytelling quality.
        </p>
      </div>
    );
  }
  if (status === 'rendering') {
    return (
      <div className="rounded-[10px] border border-border bg-surface px-4 py-3 space-y-1">
        <p className="text-[13px] font-medium text-text">Rendering in Gamma</p>
        <p className="text-[12px] text-text-3">Building the deck in your Gamma workspace.</p>
      </div>
    );
  }
  if (status === 'done') {
    return (
      <div className="rounded-[10px] border border-border bg-surface px-4 py-3 space-y-1">
        <p className="text-[13px] font-medium text-text">Deck ready</p>
        <p className="text-[12px] text-text-3">
          {gammaUrl ? 'Your presentation has been built in Gamma.' : 'Deck generated.'}
        </p>
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div className="rounded-[10px] border border-orange/40 bg-orange/5 px-4 py-3">
        <p className="text-[13px] font-medium text-text">Generation failed</p>
        <p className="text-[12px] text-text-3 mt-1">
          The deck could not be generated. Check that your LLM and Gamma credentials are configured,
          then try again.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-[10px] border border-border bg-surface px-4 py-3">
      <p className="text-[13px] font-medium text-text">Awaiting generation</p>
      <p className="text-[12px] text-text-3 mt-1">
        Source saved. The deck will be generated automatically.
      </p>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Setting up',
  running: 'Ready to generate',
  ready: 'Ready to generate',
  generating: 'Generating',
  reviewing: 'Reviewing',
  rendering: 'Rendering',
  done: 'Done',
  failed: 'Failed',
};

export function PresentationWorkflowPanel({
  workflow,
  isLoading,
  isError,
  gammaUrl,
  onClose,
}: PresentationWorkflowPanelProps) {
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center rounded-panel border border-border bg-bg">
        <p className="text-[13px] text-text-3">Loading presentation…</p>
      </div>
    );
  }

  if (isError || !workflow) {
    return (
      <div className="flex h-full flex-col rounded-panel border border-border bg-bg">
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-surface shrink-0">
          <p className="text-[14px] font-semibold text-text">Presentation</p>
          <CloseButton onClose={onClose} />
        </div>
        <div className="flex flex-1 items-center justify-center p-5">
          <p className="text-[13px] text-text-3">Could not load this presentation.</p>
        </div>
      </div>
    );
  }

  const steps = workflow.steps ?? {};
  const stepperSteps = buildPresentationSteps(steps);
  const rows = briefRows(steps);
  const title = workflow.companyName ?? 'Presentation';
  const statusLabel = STATUS_LABELS[workflow.status] ?? workflow.status;

  return (
    <div className="relative flex flex-col h-full overflow-hidden rounded-panel border border-border bg-bg">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-surface shrink-0">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-text">{title}</p>
          <p className="text-[11px] text-text-3 font-mono mt-px">Generate · {statusLabel}</p>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      <HorizontalStepper steps={stepperSteps} />

      <div className="flex flex-1 flex-col overflow-y-auto p-5 space-y-5">
        {rows.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-[13px] font-semibold text-text">Brief</h3>
            <dl className="rounded-[10px] border border-border bg-surface divide-y divide-border">
              {rows.map((row) => (
                <div key={row.label} className="flex gap-3 px-3 py-2">
                  <dt className="w-24 shrink-0 text-[12px] text-text-3">{row.label}</dt>
                  <dd className="text-[12px] text-text break-words">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <StatusBody status={workflow.status} gammaUrl={gammaUrl ?? null} />
      </div>

      <div className="border-t border-border bg-surface px-4 py-3 shrink-0 space-y-2">
        {gammaUrl && workflow.status === 'done' && (
          <a
            href={gammaUrl}
            target="_blank"
            rel="noreferrer"
            className="btn-primary w-full text-center block"
          >
            Open in Gamma
          </a>
        )}
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-[9px] border border-border bg-surface-2 px-3 py-2 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text active:scale-[0.97]"
        >
          Close
        </button>
      </div>
    </div>
  );
}
