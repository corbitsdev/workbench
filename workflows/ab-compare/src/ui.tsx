import { type ReactNode, useState } from 'react';
import { type } from 'arktype';
import type { RunState, StepState } from '@intx/workflow';
import {
  Button,
  HorizontalStepper,
  Markdown,
  type WorkflowPanelProps,
  type WorkflowStep,
} from '@workbench/ui';

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

// Agent `step` output shape: { reply: string, turn: unknown }
const AgentStepOutput = type({ reply: 'string', 'turn?': 'unknown' });

// The compareAgent is instructed to emit STRICT JSON in its reply.
// We try to parse it for richer rendering; fall back to raw reply text.
const CompareJSON = type({
  'summary?': 'string',
  'ranking?': type({
    rank: 'number',
    label: 'string',
    'rationale?': 'string',
  }).array(),
});

// `deterministicToolStep` output: { callId: string, content: "<JSON string>" }
const ToolResultEnvelope = type({ callId: 'string', content: 'string' });

const PersistContent = type({
  'artifactId?': 'string',
  'title?': 'string',
  'kind?': 'string',
  'version?': 'number',
});

type StepPhase = StepState['phase'];

function phaseFor(state: RunState | null, stepId: StepKey): StepPhase | undefined {
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
    status: toStepperStatus(phaseFor(state, stepId)),
  }));
}

/**
 * Returns the first step that is not yet `completed`, or `"persist"` when all
 * steps are done (final state). This drives the guided "render only the active
 * step" rule.
 */
function activeStep(state: RunState | null): StepKey {
  for (const id of STEP_ORDER) {
    if (phaseFor(state, id) !== 'completed') return id;
  }
  return 'persist';
}

// ── Shared layout ────────────────────────────────────────────────────────────

function Card({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-panel border border-border bg-surface p-6">{children}</section>
  );
}

function CardTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-4 text-sm font-medium text-text">{children}</h3>;
}

function LoadingState({ label }: { label: string }) {
  return (
    <Card>
      <p className="text-sm text-text-3">{label}</p>
    </Card>
  );
}

// ── Step screens ─────────────────────────────────────────────────────────────

function InputScreen({
  phase,
  connected,
  signalPending,
  onSubmit,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  signalPending: boolean;
  onSubmit: (payload: { prompt: string }) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const canSubmit = connected && !signalPending && prompt.trim().length > 0;

  if (phase !== 'awaiting-signal') {
    return <LoadingState label="Waiting for the run to start…" />;
  }

  return (
    <Card>
      <CardTitle>Enter a prompt to compare across variants</CardTitle>
      <p className="mb-4 text-xs text-text-3">
        The prompt runs blind across the available variants. You'll review the ranked outputs before
        anything is saved.
      </p>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          onSubmit({ prompt: prompt.trim() });
        }}
      >
        <label className="block space-y-1">
          <span className="text-sm font-medium text-text">Shared prompt</span>
          <textarea
            className="w-full rounded-lg border border-border bg-surface-2 p-3 text-sm text-text"
            rows={5}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="The prompt to run against each variant"
          />
        </label>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" size="sm" disabled={!canSubmit}>
            Start comparison
          </Button>
          {!connected && <p className="text-xs text-text-3">Reconnecting — input unavailable.</p>}
        </div>
      </form>
    </Card>
  );
}

function ExecuteScreen({ phase, output }: { phase: StepPhase | undefined; output: unknown }) {
  if (phase === 'in-flight' || phase === undefined) {
    return <LoadingState label="Running the prompt across variants…" />;
  }

  const parsed = AgentStepOutput(output);
  if (parsed instanceof type.errors) {
    if (phase === 'completed') {
      return (
        <Card>
          <p className="text-sm text-orange">Couldn't read the execution output.</p>
        </Card>
      );
    }
    return <LoadingState label="Running the prompt across variants…" />;
  }

  return (
    <Card>
      <CardTitle>Execution output</CardTitle>
      <Markdown>{parsed.reply}</Markdown>
    </Card>
  );
}

function CompareScreen({ phase, output }: { phase: StepPhase | undefined; output: unknown }) {
  if (phase === 'in-flight' || phase === undefined) {
    return <LoadingState label="Generating blind ranking…" />;
  }

  const parsed = AgentStepOutput(output);
  if (parsed instanceof type.errors) {
    if (phase === 'completed') {
      return (
        <Card>
          <p className="text-sm text-orange">Couldn't read the comparison output.</p>
        </Card>
      );
    }
    return <LoadingState label="Generating blind ranking…" />;
  }

  // The compareAgent emits strict JSON in `reply`. Try to parse it for rich UI.
  let decoded: unknown;
  try {
    decoded = JSON.parse(parsed.reply);
  } catch {
    decoded = undefined;
  }

  const structured = decoded !== undefined ? CompareJSON(decoded) : undefined;
  const rich =
    structured !== undefined && !(structured instanceof type.errors) ? structured : undefined;

  if (rich !== undefined) {
    return (
      <Card>
        <CardTitle>Blind ranking</CardTitle>
        {rich.summary !== undefined && <p className="mb-4 text-sm text-text-2">{rich.summary}</p>}
        {rich.ranking !== undefined && rich.ranking.length > 0 ? (
          <ol className="space-y-2">
            {rich.ranking.map((entry, index) => (
              <li
                key={index}
                className="flex gap-3 rounded-lg border border-border bg-surface-2 p-3"
              >
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-orange text-xs font-medium text-white">
                  {entry.rank}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text">{entry.label}</p>
                  {entry.rationale !== undefined && (
                    <p className="text-sm text-text-3">{entry.rationale}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </Card>
    );
  }

  // Fallback: render reply as markdown (agent didn't emit strict JSON).
  return (
    <Card>
      <CardTitle>Blind ranking</CardTitle>
      <Markdown>{parsed.reply}</Markdown>
    </Card>
  );
}

function ReviewScreen({
  phase,
  compareOutput,
  connected,
  signalPending,
  onApprove,
}: {
  phase: StepPhase | undefined;
  compareOutput: unknown;
  connected: boolean;
  signalPending: boolean;
  onApprove: () => void;
}) {
  if (phase !== 'awaiting-signal' && phase !== 'in-flight') {
    return <LoadingState label="Waiting for comparison to finish…" />;
  }

  return (
    <div className="space-y-4">
      {/* Show the comparison result above the approval gate. */}
      <CompareScreen phase="completed" output={compareOutput} />

      <Card>
        <CardTitle>Review and approve</CardTitle>
        <p className="mb-4 text-sm text-text-2">
          Review the blind ranking above. Approve to save the results as an artifact.
        </p>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            disabled={!connected || signalPending || phase !== 'awaiting-signal'}
            onClick={onApprove}
          >
            Approve comparison
          </Button>
          {!connected && (
            <p className="text-xs text-text-3">Reconnecting — approval unavailable.</p>
          )}
        </div>
      </Card>
    </div>
  );
}

function PersistScreen({
  phase,
  output,
  onClose,
}: {
  phase: StepPhase | undefined;
  output: unknown;
  onClose: () => void;
}) {
  if (phase === 'in-flight' || phase === undefined) {
    return <LoadingState label="Saving artifact…" />;
  }

  const envelope = ToolResultEnvelope(output);
  if (envelope instanceof type.errors) {
    if (phase === 'completed') {
      return (
        <Card>
          <p className="text-sm text-orange">Couldn't read the saved artifact.</p>
        </Card>
      );
    }
    return <LoadingState label="Saving artifact…" />;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(envelope.content);
  } catch {
    decoded = undefined;
  }

  const artifact = decoded !== undefined ? PersistContent(decoded) : undefined;
  const saved = artifact !== undefined && !(artifact instanceof type.errors) ? artifact : undefined;

  return (
    <Card>
      <CardTitle>Comparison saved</CardTitle>
      {saved !== undefined ? (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 p-3">
          <span className="min-w-0 truncate text-sm text-text">
            {saved.title ?? saved.artifactId ?? 'Saved artifact'}
          </span>
          {saved.kind !== undefined && <span className="text-xs text-text-3">{saved.kind}</span>}
        </div>
      ) : (
        <p className="mb-4 text-sm text-text-3">Artifact saved.</p>
      )}
      <Button variant="ghost" size="sm" onClick={onClose}>
        Close
      </Button>
    </Card>
  );
}

// ── Root panel ────────────────────────────────────────────────────────────────

export function Panel(props: WorkflowPanelProps) {
  const { state, connected, signalPending, stepOutputs, onSignal, onClose } = props;
  const failed = state?.phase === 'failed';
  const current = activeStep(state);

  function handleInputSubmit(payload: { prompt: string }) {
    onSignal(INPUT_SIGNAL, payload);
  }

  function handleApprove() {
    onSignal(REVIEW_SIGNAL, { approved: true });
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-medium text-text">A/B Compare</h2>
          <p className="text-xs text-text-3">Blind ranking across content variants</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close panel">
          Close
        </Button>
      </header>

      <HorizontalStepper steps={buildStepperSteps(state)} />

      <div className="flex-1 overflow-y-auto p-6">
        {failed ? (
          <div className="rounded-panel border border-orange bg-orange-soft p-4">
            <p className="text-sm text-orange-deep">
              This run failed. Review the run log and try again.
            </p>
          </div>
        ) : current === 'input' ? (
          <InputScreen
            phase={phaseFor(state, 'input')}
            connected={connected}
            signalPending={signalPending}
            onSubmit={handleInputSubmit}
          />
        ) : current === 'execute' ? (
          <ExecuteScreen phase={phaseFor(state, 'execute')} output={stepOutputs['execute']} />
        ) : current === 'compare' ? (
          <CompareScreen phase={phaseFor(state, 'compare')} output={stepOutputs['compare']} />
        ) : current === 'review' ? (
          <ReviewScreen
            phase={phaseFor(state, 'review')}
            compareOutput={stepOutputs['compare']}
            connected={connected}
            signalPending={signalPending}
            onApprove={handleApprove}
          />
        ) : (
          <PersistScreen
            phase={phaseFor(state, 'persist')}
            output={stepOutputs['persist']}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
