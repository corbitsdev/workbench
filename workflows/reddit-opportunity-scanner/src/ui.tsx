import { useState } from 'react';
import { type } from 'arktype';
import type { RunState, StepState } from '@intx/workflow';
import {
  Button,
  HorizontalStepper,
  type WorkflowPanelProps,
  type WorkflowStep,
} from '@workbench/ui';

// ── Step order + labels ───────────────────────────────────────────────────────

const STEP_ORDER = ['intake', 'scan', 'review', 'persist'] as const;
type StepKey = (typeof STEP_ORDER)[number];

const STEP_LABELS: Record<StepKey, string> = {
  intake: 'Intake',
  scan: 'Scan',
  review: 'Review',
  persist: 'Persist',
};

const INTAKE_SIGNAL = 'intake';
const REVIEW_SIGNAL = 'recommendation-review';

// ── Output schemas ────────────────────────────────────────────────────────────

// Agent `step` output: the sidecar wraps the agent's reply in { reply, turn }.
// We JSON.parse(reply) to get structured data when the agent emits strict JSON.
const AgentStepOutput = type({ reply: 'string', 'turn?': 'unknown' });

const Opportunity = type({
  id: 'string',
  title: 'string',
  subreddit: 'string',
  signal: "'buying-signal' | 'pain-point' | 'competitor-mention'",
  detail: 'string',
  'url?': 'string',
});

export type Opportunity = typeof Opportunity.infer;

const ScanJSON = type({ 'opportunities?': Opportunity.array() });

// deterministicToolStep output: { callId: string, content: "<JSON>" }
const ToolResultEnvelope = type({ callId: 'string', content: 'string' });

const PersistContent = type({
  'artifactId?': 'string',
  'title?': 'string',
  'kind?': 'string',
  'version?': 'number',
});

// ── Phase helpers ─────────────────────────────────────────────────────────────

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
 * Derives which step screen to render. Returns the first step that is not
 * `completed`, or `"persist"` when all steps are done.
 */
function activeStep(state: RunState | null): StepKey {
  for (const id of STEP_ORDER) {
    if (phaseFor(state, id) !== 'completed') return id;
  }
  return 'persist';
}

// ── Shared primitives ─────────────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-panel border border-border bg-surface p-6">{children}</section>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-4 text-sm font-semibold text-text">{children}</h3>;
}

function Spinner() {
  return (
    <div className="flex items-center gap-2 text-sm text-text-3">
      <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-text-3" />
      Working…
    </div>
  );
}

function ErrorCard({ title, detail }: { title: string; detail?: string }) {
  return (
    <Card>
      <p className="text-sm font-medium text-orange">{title}</p>
      {detail !== undefined ? <p className="mt-1 text-xs text-text-3">{detail}</p> : null}
    </Card>
  );
}

// ── Chip input ────────────────────────────────────────────────────────────────

function ChipInput({
  id,
  label,
  hint,
  placeholder,
  items,
  onAdd,
  onRemove,
}: {
  id: string;
  label: string;
  hint?: string;
  placeholder: string;
  items: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    if (!items.includes(trimmed)) onAdd(trimmed);
    setDraft('');
  };

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-text">
        {label}
        {hint !== undefined ? <span className="ml-1 text-text-3"> {hint}</span> : null}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
        />
        <Button type="button" variant="ghost" size="sm" onClick={commit}>
          Add
        </Button>
      </div>
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {items.map((item) => (
            <span
              key={item}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-xs text-text-2"
            >
              {item}
              <button
                type="button"
                aria-label={`Remove ${item}`}
                onClick={() => onRemove(item)}
                className="ml-0.5 text-text-3 hover:text-text"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Screen: Intake ────────────────────────────────────────────────────────────

function IntakeScreen({
  phase,
  connected,
  onSubmit,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  onSubmit: (payload: { subreddits: string[]; keywords: string[] }) => void;
}) {
  const [subreddits, setSubreddits] = useState<string[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);

  const canSubmit = connected && subreddits.length > 0 && keywords.length > 0;

  if (phase !== 'awaiting-signal') {
    return (
      <Card>
        <Spinner />
      </Card>
    );
  }

  return (
    <Card>
      <CardTitle>Where should we look?</CardTitle>
      <p className="mb-5 text-xs text-text-3">
        Add the subreddits and keywords you want to scan. Press Enter or comma to add each one.
      </p>
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          onSubmit({ subreddits, keywords });
        }}
      >
        <ChipInput
          id="intake-subreddits"
          label="Subreddits"
          hint="(without r/)"
          placeholder="e.g. devops"
          items={subreddits}
          onAdd={(v) => setSubreddits((prev) => [...prev, v])}
          onRemove={(v) => setSubreddits((prev) => prev.filter((s) => s !== v))}
        />
        <ChipInput
          id="intake-keywords"
          label="Keywords"
          placeholder="e.g. observability"
          items={keywords}
          onAdd={(v) => setKeywords((prev) => [...prev, v])}
          onRemove={(v) => setKeywords((prev) => prev.filter((k) => k !== v))}
        />
        <div className="flex items-center gap-3 pt-1">
          <Button type="submit" variant="primary" size="sm" disabled={!canSubmit}>
            Start scan
          </Button>
          {!connected ? (
            <p className="text-xs text-text-3">Reconnecting — input unavailable.</p>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

// ── Screen: Scan ──────────────────────────────────────────────────────────────

function parseScanOutput(raw: unknown): Opportunity[] | 'pending' | 'error' {
  const envelope = AgentStepOutput(raw);
  if (envelope instanceof type.errors) return 'pending';

  let decoded: unknown;
  try {
    decoded = JSON.parse(envelope.reply);
  } catch {
    return 'error';
  }

  const parsed = ScanJSON(decoded);
  if (parsed instanceof type.errors) return 'error';
  return parsed.opportunities ?? [];
}

function ScanScreen({ phase, output }: { phase: StepPhase | undefined; output: unknown }) {
  if (phase === 'in-flight' || phase === undefined) {
    return (
      <Card>
        <CardTitle>Scanning Reddit</CardTitle>
        <Spinner />
      </Card>
    );
  }

  const result = parseScanOutput(output);

  if (result === 'error') {
    return (
      <ErrorCard
        title="Couldn't read the scan output."
        detail="The scan step finished but its result was malformed."
      />
    );
  }

  if (result === 'pending') {
    return (
      <Card>
        <CardTitle>Scanning Reddit</CardTitle>
        <Spinner />
      </Card>
    );
  }

  if (result.length === 0) {
    return (
      <Card>
        <CardTitle>Scanning Reddit</CardTitle>
        <p className="text-sm text-text-3">No opportunities found yet.</p>
      </Card>
    );
  }

  return (
    <Card>
      <CardTitle>Scan complete — {result.length} opportunities found</CardTitle>
      <div className="space-y-2">
        {result.map((opp) => (
          <OpportunityCard key={opp.id} opportunity={opp} />
        ))}
      </div>
    </Card>
  );
}

function SignalBadge({ signal }: { signal: Opportunity['signal'] }) {
  const MAP = {
    'buying-signal': { label: 'Buying signal', className: 'bg-green/10 text-green' },
    'pain-point': { label: 'Pain point', className: 'bg-orange/10 text-orange' },
    'competitor-mention': {
      label: 'Competitor',
      className: 'bg-surface-2 text-text-2 border border-border',
    },
  } as const;
  const cfg = MAP[signal];
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}

function OpportunityCard({
  opportunity,
  selected,
  onToggle,
}: {
  opportunity: Opportunity;
  selected?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div
      className={`rounded-lg border bg-surface-2 p-3 ${
        selected === true ? 'border-orange' : 'border-border'
      } ${onToggle !== undefined ? 'cursor-pointer transition-colors hover:border-border-strong' : ''}`}
      onClick={onToggle}
      role={onToggle !== undefined ? 'checkbox' : undefined}
      aria-checked={selected}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text">{opportunity.title}</p>
          <p className="mt-0.5 font-mono text-xs text-text-3">r/{opportunity.subreddit}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SignalBadge signal={opportunity.signal} />
          {onToggle !== undefined ? (
            <div
              className={`h-4 w-4 rounded border ${
                selected === true ? 'border-orange bg-orange' : 'border-border bg-bg'
              } flex items-center justify-center`}
            >
              {selected === true ? (
                <svg
                  className="h-2.5 w-2.5 text-white"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M1.5 5l2.5 2.5 4.5-4.5" />
                </svg>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <p className="mt-1.5 text-xs text-text-2">{opportunity.detail}</p>
      {opportunity.url !== undefined ? (
        <a
          href={opportunity.url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-xs text-orange hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          Open thread
        </a>
      ) : null}
    </div>
  );
}

// ── Screen: Review ────────────────────────────────────────────────────────────

function ReviewScreen({
  phase,
  connected,
  scanOutput,
  onSubmit,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  scanOutput: unknown;
  onSubmit: (payload: { selected: Opportunity[] }) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const result = parseScanOutput(scanOutput);
  const opportunities = Array.isArray(result) ? result : [];

  const canSubmit = connected && selectedIds.size > 0;

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  if (phase !== 'awaiting-signal') {
    return (
      <Card>
        <Spinner />
      </Card>
    );
  }

  if (opportunities.length === 0) {
    return (
      <ErrorCard
        title="No opportunities to review."
        detail="The scan step produced no results. Start a new run with different subreddits or keywords."
      />
    );
  }

  const selectedOpportunities = opportunities.filter((o) => selectedIds.has(o.id));

  return (
    <Card>
      <CardTitle>Select opportunities to save</CardTitle>
      <p className="mb-4 text-xs text-text-3">
        Choose which opportunities to persist as artifacts. Each saved item becomes a document in
        your workbench.
      </p>
      <div className="space-y-2">
        {opportunities.map((opp) => (
          <OpportunityCard
            key={opp.id}
            opportunity={opp}
            selected={selectedIds.has(opp.id)}
            onToggle={() => toggleId(opp.id)}
          />
        ))}
      </div>
      <div className="mt-5 flex items-center gap-3">
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={!canSubmit}
          onClick={() => {
            if (!canSubmit) return;
            onSubmit({ selected: selectedOpportunities });
          }}
        >
          Save {selectedIds.size > 0 ? `${selectedIds.size} ` : ''}
          {selectedIds.size === 1 ? 'opportunity' : 'opportunities'}
        </Button>
        {!connected ? (
          <p className="text-xs text-text-3">Reconnecting — action unavailable.</p>
        ) : null}
      </div>
    </Card>
  );
}

// ── Screen: Persist ───────────────────────────────────────────────────────────

function readPersistedArtifact(
  raw: unknown
): { artifactId?: string; title?: string; kind?: string } | undefined {
  const envelope = ToolResultEnvelope(raw);
  if (envelope instanceof type.errors) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(envelope.content);
  } catch {
    return undefined;
  }
  const parsed = PersistContent(decoded);
  if (parsed instanceof type.errors) return undefined;
  return {
    ...(parsed.artifactId !== undefined ? { artifactId: parsed.artifactId } : {}),
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
  };
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
    return (
      <Card>
        <CardTitle>Saving artifacts</CardTitle>
        <Spinner />
      </Card>
    );
  }

  // `persist` is a `map` — its output is an array of tool-result envelopes,
  // one per selected opportunity.
  const items = Array.isArray(output) ? output : [];
  const artifacts = items
    .map(readPersistedArtifact)
    .filter((a): a is NonNullable<typeof a> => a !== undefined);

  return (
    <Card>
      <CardTitle>
        Done — {artifacts.length} artifact{artifacts.length === 1 ? '' : 's'} saved
      </CardTitle>
      {artifacts.length > 0 ? (
        <div className="space-y-2">
          {artifacts.map((artifact, index) => (
            <div
              key={artifact.artifactId ?? index}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2"
            >
              <span className="min-w-0 truncate text-sm text-text">
                {artifact.title ?? artifact.artifactId ?? 'Saved artifact'}
              </span>
              {artifact.kind !== undefined ? (
                <span className="shrink-0 text-xs text-text-3">{artifact.kind}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-text-3">No artifacts could be read from the persist output.</p>
      )}
      <div className="mt-5">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </Card>
  );
}

// ── Root Panel ────────────────────────────────────────────────────────────────

export function Panel(props: WorkflowPanelProps) {
  const { state, connected, stepOutputs, onSignal, onClose } = props;

  const active = activeStep(state);
  const runPhase = state?.phase;
  const failed = runPhase === 'failed' || runPhase === 'cancelled';

  const failedStep = STEP_ORDER.find((id) => {
    const p = phaseFor(state, id);
    return p === 'failed' || p === 'cancelled';
  });
  const failError =
    failedStep !== undefined ? state?.steps.get(failedStep)?.lastError?.message : undefined;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-panel border border-border bg-bg">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text">Reddit Opportunity Scanner</p>
          <p className="mt-px font-mono text-[11px] text-text-3">
            {connected ? 'Live' : 'Reconnecting'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-7 w-7 place-items-center rounded-lg border border-border text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
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

      <HorizontalStepper steps={buildStepperSteps(state)} />

      {/* Body — guided: only the active step screen is rendered */}
      <div className="flex-1 overflow-y-auto p-5">
        {failed ? (
          <ErrorCard
            title="This run failed."
            detail={failError ?? 'Review the step details and start a new run.'}
          />
        ) : active === 'intake' ? (
          <IntakeScreen
            phase={phaseFor(state, 'intake')}
            connected={connected}
            onSubmit={(payload) => onSignal(INTAKE_SIGNAL, payload)}
          />
        ) : active === 'scan' ? (
          <ScanScreen phase={phaseFor(state, 'scan')} output={stepOutputs['scan']} />
        ) : active === 'review' ? (
          <ReviewScreen
            phase={phaseFor(state, 'review')}
            connected={connected}
            scanOutput={stepOutputs['scan']}
            onSubmit={(payload) => onSignal(REVIEW_SIGNAL, payload)}
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
