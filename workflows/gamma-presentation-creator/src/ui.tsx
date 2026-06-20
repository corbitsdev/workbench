import { type } from 'arktype';
import { HorizontalStepper, type WorkflowPanelProps, type WorkflowStep } from '@workbench/ui';
import type { RunState } from '@intx/workflow';

const STEPS = [
  { id: 'template', label: 'Template' },
  { id: 'source', label: 'Source' },
  { id: 'generate', label: 'Generate' },
  { id: 'review', label: 'Review' },
  { id: 'render', label: 'Render' },
] as const;

type StepPhase = NonNullable<ReturnType<RunState['steps']['get']>>['phase'];

const TemplateOutput = type({
  'templateId?': 'string',
  'audience?': 'string',
  'tone?': 'string',
  'goal?': 'string',
});

const SourceOutput = type({
  'callTitle?': 'string',
  'summary?': 'string',
});

const GenerateOutput = type({
  'title?': 'string',
  'outline?': 'string',
});

const RenderOutput = type({
  'gammaUrl?': 'string',
  'url?': 'string',
});

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stepPhase(state: RunState | null, stepId: string): StepPhase | undefined {
  return state?.steps.get(stepId)?.phase;
}

function toStepperStatus(phase: StepPhase | undefined, isCurrent: boolean): WorkflowStep['status'] {
  if (phase === 'completed') return 'completed';
  if (
    phase === 'in-flight' ||
    phase === 'awaiting-signal' ||
    phase === 'awaiting-timer' ||
    isCurrent
  ) {
    return 'current';
  }
  return 'pending';
}

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  const firstActiveIndex = STEPS.findIndex((s) => {
    const phase = stepPhase(state, s.id);
    return phase !== 'completed';
  });
  return STEPS.map((s, index) => {
    const phase = stepPhase(state, s.id);
    return {
      number: index + 1,
      label: s.label,
      status: toStepperStatus(phase, index === firstActiveIndex),
    };
  });
}

function briefRows(stepOutputs: Record<string, unknown>): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const template = TemplateOutput(stepOutputs.template);
  if (!(template instanceof type.errors)) {
    const templateId = readString(template.templateId);
    if (templateId) rows.push({ label: 'Template', value: templateId });
    const audience = readString(template.audience);
    if (audience) rows.push({ label: 'Audience', value: audience });
    const tone = readString(template.tone);
    if (tone) rows.push({ label: 'Tone', value: tone });
    const goal = readString(template.goal);
    if (goal) rows.push({ label: 'Goal', value: goal });
  }
  const source = SourceOutput(stepOutputs.source);
  if (!(source instanceof type.errors)) {
    const callTitle = readString(source.callTitle);
    if (callTitle) rows.push({ label: 'Source', value: callTitle });
  }
  return rows;
}

function readGenerate(stepOutputs: Record<string, unknown>): {
  title: string | undefined;
  outline: string | undefined;
} {
  const parsed = GenerateOutput(stepOutputs.generate);
  if (parsed instanceof type.errors) return { title: undefined, outline: undefined };
  return { title: readString(parsed.title), outline: readString(parsed.outline) };
}

function readGammaUrl(stepOutputs: Record<string, unknown>): string | undefined {
  const parsed = RenderOutput(stepOutputs.render);
  if (parsed instanceof type.errors) return undefined;
  return readString(parsed.gammaUrl) ?? readString(parsed.url);
}

function isSafePresentationUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
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

function PresentationFrame({ url }: { url: string }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-surface">
      <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
        <iframe
          src={url}
          allow="fullscreen"
          sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
          className="absolute inset-0 h-full w-full border-0"
          title="Generated Gamma presentation"
        />
      </div>
    </div>
  );
}

const RUN_PHASE_LABEL: Record<string, string> = {
  pending: 'Setting up',
  running: 'Running',
  cancelling: 'Cancelling',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function Panel({ state, connected, stepOutputs, onSignal, onClose }: WorkflowPanelProps) {
  const stepperSteps = buildStepperSteps(state);
  const rows = briefRows(stepOutputs);
  const generate = readGenerate(stepOutputs);
  const gammaUrl = readGammaUrl(stepOutputs);
  const reviewPhase = stepPhase(state, 'review');
  const renderPhase = stepPhase(state, 'render');
  const runPhase = state?.phase ?? 'pending';
  const statusLabel = RUN_PHASE_LABEL[runPhase] ?? runPhase;
  const awaitingReview = reviewPhase === 'awaiting-signal';
  const isDone = renderPhase === 'completed' && runPhase === 'completed';

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-panel border border-border bg-bg">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-text">
            {generate.title ?? 'Gamma Presentation'}
          </p>
          <p className="mt-px font-mono text-[11px] text-text-3">
            {statusLabel}
            {connected ? '' : ' · disconnected'}
          </p>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      <HorizontalStepper steps={stepperSteps} />

      <div className="flex flex-1 flex-col space-y-5 overflow-y-auto p-5">
        {rows.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-[13px] font-semibold text-text">Brief</h3>
            <dl className="divide-y divide-border rounded-[10px] border border-border bg-surface">
              {rows.map((row) => (
                <div key={row.label} className="flex gap-3 px-3 py-2">
                  <dt className="w-24 shrink-0 text-[12px] text-text-3">{row.label}</dt>
                  <dd className="break-words text-[12px] text-text">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {generate.outline && (
          <div className="space-y-2">
            <h3 className="text-[13px] font-semibold text-text">Draft outline</h3>
            <div className="rounded-[10px] border border-border bg-surface px-4 py-3">
              <p className="whitespace-pre-wrap text-[12px] text-text-2">{generate.outline}</p>
            </div>
          </div>
        )}

        {awaitingReview && (
          <div className="space-y-1 rounded-[10px] border border-orange/40 bg-orange/5 px-4 py-3">
            <p className="text-[13px] font-medium text-text">Review the draft</p>
            <p className="text-[12px] text-text-3">
              Approve the generated content to render the deck in Gamma.
            </p>
          </div>
        )}

        {runPhase === 'failed' && (
          <div className="rounded-[10px] border border-orange/40 bg-orange/5 px-4 py-3">
            <p className="text-[13px] font-medium text-text">Generation failed</p>
            <p className="mt-1 text-[12px] text-text-3">
              The deck could not be generated. Start a new run to try again.
            </p>
          </div>
        )}

        {isDone &&
          gammaUrl &&
          (isSafePresentationUrl(gammaUrl) ? (
            <PresentationFrame url={gammaUrl} />
          ) : (
            <p className="rounded-[10px] border border-orange/40 bg-orange/5 px-4 py-3 text-[12px] text-text-3">
              Presentation URL is invalid or unavailable.
            </p>
          ))}
      </div>

      <div className="shrink-0 space-y-2 border-t border-border bg-surface px-4 py-3">
        {awaitingReview && (
          <button
            type="button"
            onClick={() => onSignal('review-approval', { approved: true })}
            className="btn-primary block w-full text-center"
          >
            Approve
          </button>
        )}
        {isDone && isSafePresentationUrl(gammaUrl) && (
          <a
            href={gammaUrl}
            target="_blank"
            rel="noreferrer"
            className="btn-primary block w-full text-center"
          >
            Open in Gamma
          </a>
        )}
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-[9px] border border-border bg-surface-2 px-3 py-2 text-[13px] font-medium text-text-2 transition-colors hover:text-text active:scale-[0.97]"
        >
          Close
        </button>
      </div>
    </div>
  );
}
