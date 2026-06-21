import { type } from 'arktype';
import { HorizontalStepper, type WorkflowPanelProps } from '@workbench/ui';
import type { StepPhase, StepState } from '@intx/workflow';
import type { WorkflowStep } from '@workbench/ui';

const STEP_IDS = ['intake', 'select', 'fetch', 'analyze', 'generate', 'approval'] as const;
type StepId = (typeof STEP_IDS)[number];

const STEP_LABELS: Record<StepId, string> = {
  intake: 'Intake',
  select: 'Select',
  fetch: 'Fetch',
  analyze: 'Analyze',
  generate: 'Generate',
  approval: 'Approve',
};

const APPROVAL_SIGNAL = 'artifact-approval';
const SELECTION_SIGNAL = 'note-selection';

const ToolResultEnvelope = type({
  content: 'string',
});

const GranolaNote = type({
  id: 'string',
  'title?': 'string | null',
  'created_at?': 'string',
  'summary?': 'string',
});
type GranolaNoteShape = typeof GranolaNote.infer;

const GranolaListContent = type({
  notes: GranolaNote.array(),
});

const GranolaNoteContent = type({
  id: 'string',
  'title?': 'string | null',
  'summary?': 'string',
});

type Decoded = { status: 'pending' } | { status: 'malformed' } | { status: 'ok'; value: unknown };

/**
 * Deterministic tool steps return the agent-runtime `ToolResult` whose
 * `content` is the tool handler's JSON string. Peel the envelope and parse the
 * embedded JSON. `pending` = not a tool result yet; `malformed` = a tool
 * result whose content is not valid JSON.
 */
function decodeToolContent(output: unknown): Decoded {
  const envelope = ToolResultEnvelope(output);
  if (envelope instanceof type.errors) return { status: 'pending' };
  try {
    return { status: 'ok', value: JSON.parse(envelope.content) };
  } catch {
    return { status: 'malformed' };
  }
}

type NoteListResult =
  | { status: 'pending' }
  | { status: 'malformed' }
  | { status: 'ok'; notes: GranolaNoteShape[] };

function parseNoteList(output: unknown): NoteListResult {
  const decoded = decodeToolContent(output);
  if (decoded.status !== 'ok') return decoded;
  const parsed = GranolaListContent(decoded.value);
  if (parsed instanceof type.errors) return { status: 'malformed' };
  return { status: 'ok', notes: parsed.notes };
}

// Agent steps return the agent-runtime turn: { reply: string, turn: {...} }.
// The reply is the human-readable markdown the step produced.
const AgentReplyOutput = type({
  reply: 'string',
});

function phaseFor(steps: WorkflowPanelProps['state'], id: StepId): StepPhase | undefined {
  if (!steps) return undefined;
  const found: StepState | undefined = steps.steps.get(id);
  return found?.phase;
}

function toStepperStatus(phase: StepPhase | undefined, isCurrent: boolean): WorkflowStep['status'] {
  if (phase === 'completed') return 'completed';
  if (isCurrent) return 'current';
  return 'pending';
}

function buildStepperSteps(state: WorkflowPanelProps['state']): WorkflowStep[] {
  const activeIndex = STEP_IDS.findIndex((id) => {
    const phase = phaseFor(state, id);
    return phase === 'in-flight' || phase === 'awaiting-signal' || phase === 'awaiting-timer';
  });

  return STEP_IDS.map((id, index) => {
    const phase = phaseFor(state, id);
    const isCurrent = index === activeIndex;
    return {
      number: index + 1,
      label: STEP_LABELS[id],
      status: toStepperStatus(phase, isCurrent),
    };
  });
}

// The single step the run is currently waiting on (or, when idle, the first
// step that has not completed). Drives the body so the panel shows ONE
// actionable step at a time — the stepper is the map; the body is the work.
function activeStepId(state: WorkflowPanelProps['state']): StepId {
  const active = STEP_IDS.find((id) => {
    const phase = phaseFor(state, id);
    return phase === 'in-flight' || phase === 'awaiting-signal' || phase === 'awaiting-timer';
  });
  if (active) return active;
  const firstIncomplete = STEP_IDS.find((id) => phaseFor(state, id) !== 'completed');
  return firstIncomplete ?? 'approval';
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-panel border border-border bg-surface p-5">
      <h3 className="mb-3 text-sm font-medium text-text">{title}</h3>
      {children}
    </section>
  );
}

function Pending({ label }: { label: string }) {
  return <p className="text-[13px] text-text-3">{label}</p>;
}

function MalformedOutput({ label }: { label: string }) {
  return <p className="text-[13px] text-orange">{label}</p>;
}

function NoteListSection({
  output,
  intakePhase,
  selectPhase,
  onSelect,
}: {
  output: unknown;
  intakePhase: StepPhase | undefined;
  selectPhase: StepPhase | undefined;
  onSelect: (noteId: string) => void;
}) {
  const result = parseNoteList(output);

  if (result.status === 'pending') {
    if (intakePhase === 'completed') {
      return <MalformedOutput label="Couldn’t read the Granola note list." />;
    }
    return <Pending label="Loading your Granola notes…" />;
  }
  if (result.status === 'malformed') {
    return <MalformedOutput label="Couldn’t read the Granola note list." />;
  }
  if (result.notes.length === 0) {
    return <Pending label="No Granola notes were found." />;
  }

  // Enable selection as soon as the select step is active. A signal delivered
  // while the step is still `in-flight` (before its SignalAwaited) is queued and
  // consumed by the runtime, so we do not gate strictly on `awaiting-signal`.
  const selectable = selectPhase === 'awaiting-signal' || selectPhase === 'in-flight';
  const chosen = selectPhase === 'completed';

  if (chosen) {
    return <p className="text-[13px] text-text-2">Note selected. Fetching the transcript…</p>;
  }

  return (
    <ul className="space-y-2">
      {result.notes.map((note) => (
        <li key={note.id}>
          <button
            type="button"
            disabled={!selectable}
            onClick={() => onSelect(note.id)}
            className="w-full rounded-panel border border-border bg-bg px-3 py-2 text-left text-[13px] text-text-2 enabled:hover:border-orange disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="block font-medium text-text">{note.title ?? 'Untitled note'}</span>
            {note.summary ? <span className="mt-0.5 block text-text-3">{note.summary}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function FetchSection({ output, phase }: { output: unknown; phase: StepPhase | undefined }) {
  const decoded = decodeToolContent(output);
  if (decoded.status === 'pending') {
    if (phase === 'completed') {
      return <MalformedOutput label="Couldn’t read the fetched Granola note." />;
    }
    return <Pending label="The selected note’s transcript appears here once fetched." />;
  }
  if (decoded.status === 'malformed') {
    return <MalformedOutput label="Couldn’t read the fetched Granola note." />;
  }
  const note = GranolaNoteContent(decoded.value);
  if (note instanceof type.errors) {
    return <MalformedOutput label="Couldn’t read the fetched Granola note." />;
  }
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium text-text">{note.title ?? 'Untitled note'}</p>
      {note.summary ? (
        <p className="text-[13px] leading-relaxed text-text-2">{note.summary}</p>
      ) : null}
    </div>
  );
}

function AnalyzeSection({ output, phase }: { output: unknown; phase: StepPhase | undefined }) {
  const parsed = AgentReplyOutput(output);
  if (parsed instanceof type.errors || parsed.reply.trim() === '') {
    if (phase === 'completed') {
      return <MalformedOutput label="Couldn’t read the extracted pain points." />;
    }
    return <Pending label="Pain points appear here once analysis completes." />;
  }
  return (
    <pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text-2">
      {parsed.reply}
    </pre>
  );
}

function GenerateSection({ output, phase }: { output: unknown; phase: StepPhase | undefined }) {
  const parsed = AgentReplyOutput(output);
  if (parsed instanceof type.errors || parsed.reply.trim() === '') {
    if (phase === 'completed') {
      return <MalformedOutput label="Couldn’t read the generated collateral." />;
    }
    return <Pending label="Generated collateral appears here once it is ready." />;
  }
  return (
    <pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text-2">
      {parsed.reply}
    </pre>
  );
}

function ApprovalSection({
  phase,
  onApprove,
}: {
  phase: StepPhase | undefined;
  onApprove: () => void;
}) {
  if (phase === 'completed') {
    return <p className="text-[13px] text-text-2">Collateral approved.</p>;
  }
  if (phase !== 'awaiting-signal') {
    return <Pending label="Approval becomes available after collateral is generated." />;
  }
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-text-2">
        Review the generated collateral above, then approve to finish the run.
      </p>
      <button
        type="button"
        onClick={onApprove}
        className="rounded-panel bg-orange px-4 py-2 text-sm font-medium text-white"
      >
        Approve
      </button>
    </div>
  );
}

export function Panel(props: WorkflowPanelProps) {
  const { state, connected, stepOutputs, onSignal, onClose } = props;

  const approvalPhase = phaseFor(state, 'approval');
  const activeId = activeStepId(state);
  const failed =
    STEP_IDS.some((id) => phaseFor(state, id) === 'failed') || state?.phase === 'failed';

  const handleApprove = () => {
    onSignal(APPROVAL_SIGNAL, { approved: true });
  };

  const handleSelect = (noteId: string) => {
    onSignal(SELECTION_SIGNAL, { noteId });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-panel border border-border bg-bg">
      <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-4">
        <div>
          <h2 className="text-sm font-medium text-text">Pain Point Collateral</h2>
          <p className="text-[12px] text-text-3">{connected ? 'Live' : 'Reconnecting…'}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-panel border border-border px-3 py-1.5 text-[13px] text-text-2"
        >
          Close
        </button>
      </header>

      <HorizontalStepper steps={buildStepperSteps(state)} />

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        {failed ? (
          <p className="rounded-panel border border-orange bg-surface px-4 py-3 text-[13px] text-orange">
            This run failed. Review the step details and start a new run.
          </p>
        ) : null}

        {(activeId === 'intake' || activeId === 'select') && (
          <SectionCard title="Select a Granola note">
            <NoteListSection
              output={stepOutputs.intake}
              intakePhase={phaseFor(state, 'intake')}
              selectPhase={phaseFor(state, 'select')}
              onSelect={handleSelect}
            />
          </SectionCard>
        )}

        {activeId === 'fetch' && (
          <SectionCard title="Fetching the transcript">
            <FetchSection output={stepOutputs.fetch} phase={phaseFor(state, 'fetch')} />
          </SectionCard>
        )}

        {activeId === 'analyze' && (
          <SectionCard title="Extracting pain points">
            <AnalyzeSection output={stepOutputs.analyze} phase={phaseFor(state, 'analyze')} />
          </SectionCard>
        )}

        {activeId === 'generate' && (
          <SectionCard title="Generating collateral">
            <GenerateSection output={stepOutputs.generate} phase={phaseFor(state, 'generate')} />
          </SectionCard>
        )}

        {activeId === 'approval' && (
          <>
            <SectionCard title="Generated collateral">
              <GenerateSection output={stepOutputs.generate} phase={phaseFor(state, 'generate')} />
            </SectionCard>
            <SectionCard title="Approve">
              <ApprovalSection phase={approvalPhase} onApprove={handleApprove} />
            </SectionCard>
          </>
        )}
      </div>
    </div>
  );
}
