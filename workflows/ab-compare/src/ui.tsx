import { type ReactNode, useState } from 'react';
import { type } from 'arktype';
import type { RunState, StepState } from '@intx/workflow';
import { Button, HorizontalStepper, type WorkflowPanelProps, type WorkflowStep } from '@workbench/ui';

const INPUT_SIGNAL = 'input';
const REVIEW_SIGNAL = 'comparison-review';

const STEP_ORDER = ['input', 'execute', 'compare', 'review', 'persist'] as const;
type StepKey = (typeof STEP_ORDER)[number];

const STEP_LABELS: Record<StepKey, string> = {
  input: 'Input',
  execute: 'Execute',
  compare: 'Compare',
  review: 'Review',
  persist: 'Persist',
};

const executeOutput = type({
  'branches?': type({
    'provider?': 'string',
    'model?': 'string',
    'output?': 'string',
    'status?': 'string',
  }).array(),
  'prompt?': 'string',
});

const compareOutput = type({
  'ranking?': type({
    'rank?': 'number',
    'label?': 'string',
    'provider?': 'string',
    'rationale?': 'string',
  }).array(),
  'summary?': 'string',
});

const persistOutput = type({
  'artifacts?': type({
    'id?': 'string',
    'title?': 'string',
    'kind?': 'string',
    'url?': 'string',
  }).array(),
});

type StepPhase = StepState['phase'];

function stepPhase(state: RunState | null, stepId: StepKey): StepPhase | undefined {
  return state?.steps.get(stepId)?.phase;
}

function toStepperStatus(phase: StepPhase | undefined): WorkflowStep['status'] {
  if (phase === 'completed') return 'completed';
  if (phase === 'in-flight' || phase === 'awaiting-signal' || phase === 'awaiting-timer') {
    return 'current';
  }
  return 'pending';
}

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  return STEP_ORDER.map((stepId, index) => ({
    number: index + 1,
    label: STEP_LABELS[stepId],
    status: toStepperStatus(stepPhase(state, stepId)),
  }));
}

function SectionCard({
  title,
  phase,
  children,
}: {
  title: string;
  phase: StepPhase | undefined;
  children: ReactNode;
}) {
  return (
    <section className="rounded-panel border border-border bg-surface p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-text">{title}</h3>
        <PhaseBadge phase={phase} />
      </div>
      {children}
    </section>
  );
}

function PhaseBadge({ phase }: { phase: StepPhase | undefined }) {
  if (!phase) {
    return <span className="text-xs text-text-3">Pending</span>;
  }
  if (phase === 'completed') {
    return <span className="text-xs font-medium text-green">Done</span>;
  }
  if (phase === 'failed' || phase === 'cancelled') {
    return <span className="text-xs font-medium text-orange-deep">{phase}</span>;
  }
  if (phase === 'awaiting-signal') {
    return <span className="text-xs font-medium text-orange">Awaiting review</span>;
  }
  return <span className="text-xs font-medium text-text-2">Running</span>;
}

function InputSection({
  phase,
  connected,
  onSubmit,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  onSubmit: (payload: { content: string; prompt: string }) => void;
}) {
  const [content, setContent] = useState('');
  const [prompt, setPrompt] = useState('');
  const canSubmit = connected && content.trim().length > 0 && prompt.trim().length > 0;

  if (phase === 'completed') {
    return (
      <SectionCard title="Input — content and prompt" phase={phase}>
        <p className="text-sm text-text-2">Input submitted.</p>
      </SectionCard>
    );
  }
  if (phase !== 'awaiting-signal') {
    return (
      <SectionCard title="Input — content and prompt" phase={phase}>
        <p className="text-sm text-text-3">Waiting for the run to start.</p>
      </SectionCard>
    );
  }
  return (
    <SectionCard title="Input — content and prompt" phase={phase}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          onSubmit({ content: content.trim(), prompt: prompt.trim() });
        }}
      >
        <label className="block space-y-1">
          <span className="text-sm font-medium text-text">Content</span>
          <textarea
            className="w-full rounded-lg border border-border bg-surface-2 p-2 text-sm text-text"
            rows={4}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="The text to compare across providers"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-text">Shared prompt</span>
          <textarea
            className="w-full rounded-lg border border-border bg-surface-2 p-2 text-sm text-text"
            rows={3}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="The prompt to run against each provider"
          />
        </label>
        <Button type="submit" variant="primary" size="sm" disabled={!canSubmit}>
          Start comparison
        </Button>
        {connected ? null : (
          <p className="text-xs text-text-3">Reconnecting — input is unavailable.</p>
        )}
      </form>
    </SectionCard>
  );
}

function ExecuteSection({ phase, output }: { phase: StepPhase | undefined; output: unknown }) {
  const parsed = executeOutput(output);
  if (parsed instanceof type.errors) {
    return (
      <SectionCard title="Execute — provider branches" phase={phase}>
        {phase === 'completed' ? (
          <p className="text-sm text-orange">Couldn’t read the provider outputs for this step.</p>
        ) : (
          <p className="text-sm text-text-3">No provider outputs yet.</p>
        )}
      </SectionCard>
    );
  }
  const branches = parsed.branches ?? [];
  return (
    <SectionCard title="Execute — provider branches" phase={phase}>
      {branches.length === 0 ? (
        <p className="text-sm text-text-3">No provider outputs yet.</p>
      ) : (
        <ul className="space-y-3">
          {branches.map((branch, index) => (
            <li key={index} className="rounded-lg border border-border bg-surface-2 p-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-text">
                  {branch.provider ?? `Branch ${index + 1}`}
                </span>
                {branch.model ? <span className="text-xs text-text-3">{branch.model}</span> : null}
              </div>
              {branch.output ? (
                <p className="whitespace-pre-wrap text-sm text-text-2">{branch.output}</p>
              ) : (
                <p className="text-sm text-text-3">{branch.status ?? 'Running…'}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function CompareSection({ phase, output }: { phase: StepPhase | undefined; output: unknown }) {
  const parsed = compareOutput(output);
  if (parsed instanceof type.errors) {
    return (
      <SectionCard title="Compare — blind ranking" phase={phase}>
        {phase === 'completed' ? (
          <p className="text-sm text-orange">Couldn’t read the ranking for this step.</p>
        ) : (
          <p className="text-sm text-text-3">No ranking yet.</p>
        )}
      </SectionCard>
    );
  }
  const ranking = parsed.ranking ?? [];
  return (
    <SectionCard title="Compare — blind ranking" phase={phase}>
      {parsed.summary ? <p className="mb-3 text-sm text-text-2">{parsed.summary}</p> : null}
      {ranking.length === 0 ? (
        <p className="text-sm text-text-3">No ranking yet.</p>
      ) : (
        <ol className="space-y-2">
          {ranking.map((entry, index) => (
            <li key={index} className="flex gap-3 rounded-lg border border-border bg-surface-2 p-3">
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-orange text-xs font-medium text-white">
                {entry.rank ?? index + 1}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">
                  {entry.label ?? entry.provider ?? `Variant ${index + 1}`}
                </p>
                {entry.rationale ? (
                  <p className="text-sm text-text-3">{entry.rationale}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}

function ReviewSection({
  phase,
  connected,
  onApprove,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  onApprove: () => void;
}) {
  return (
    <SectionCard title="Review — approval gate" phase={phase}>
      {phase === 'awaiting-signal' ? (
        <div className="space-y-3">
          <p className="text-sm text-text-2">
            Review the blind ranking above. Approve to persist the comparison results.
          </p>
          <Button variant="primary" size="sm" disabled={!connected} onClick={onApprove}>
            Approve comparison
          </Button>
          {connected ? null : (
            <p className="text-xs text-text-3">Reconnecting — approval is unavailable.</p>
          )}
        </div>
      ) : phase === 'completed' ? (
        <p className="text-sm text-text-2">Comparison approved.</p>
      ) : (
        <p className="text-sm text-text-3">Waiting for the comparison to finish.</p>
      )}
    </SectionCard>
  );
}

function PersistSection({ phase, output }: { phase: StepPhase | undefined; output: unknown }) {
  const parsed = persistOutput(output);
  if (parsed instanceof type.errors) {
    return (
      <SectionCard title="Persist — saved artifacts" phase={phase}>
        {phase === 'completed' ? (
          <p className="text-sm text-orange">Couldn’t read the saved artifacts for this step.</p>
        ) : (
          <p className="text-sm text-text-3">No artifacts saved yet.</p>
        )}
      </SectionCard>
    );
  }
  const artifacts = parsed.artifacts ?? [];
  return (
    <SectionCard title="Persist — saved artifacts" phase={phase}>
      {artifacts.length === 0 ? (
        <p className="text-sm text-text-3">No artifacts saved yet.</p>
      ) : (
        <ul className="space-y-2">
          {artifacts.map((artifact, index) => (
            <li
              key={artifact.id ?? index}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 p-3"
            >
              <span className="min-w-0 truncate text-sm text-text">
                {artifact.title ?? artifact.id ?? `Artifact ${index + 1}`}
              </span>
              {artifact.kind ? <span className="text-xs text-text-3">{artifact.kind}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

export function Panel(props: WorkflowPanelProps) {
  const { state, connected, stepOutputs, onSignal, onClose } = props;
  const failed = state?.phase === 'failed';

  function handleApprove() {
    onSignal(REVIEW_SIGNAL, { approved: true });
  }

  function handleInputSubmit(payload: { content: string; prompt: string }) {
    onSignal(INPUT_SIGNAL, payload);
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-medium text-text">A/B Compare</h2>
          <p className="text-xs text-text-3">Blind ranking across provider variants</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close panel">
          Close
        </Button>
      </header>

      <HorizontalStepper steps={buildStepperSteps(state)} />

      {failed ? (
        <div className="mx-6 mt-4 rounded-panel border border-orange bg-orange-soft p-4">
          <p className="text-sm text-orange-deep">
            This run failed. Review the run log and try again.
          </p>
        </div>
      ) : null}

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        <InputSection
          phase={stepPhase(state, 'input')}
          connected={connected}
          onSubmit={handleInputSubmit}
        />
        <ExecuteSection phase={stepPhase(state, 'execute')} output={stepOutputs.execute} />
        <CompareSection phase={stepPhase(state, 'compare')} output={stepOutputs.compare} />
        <ReviewSection
          phase={stepPhase(state, 'review')}
          connected={connected}
          onApprove={handleApprove}
        />
        <PersistSection phase={stepPhase(state, 'persist')} output={stepOutputs.persist} />
      </div>
    </div>
  );
}
