import { type } from 'arktype';
import { HorizontalStepper, type WorkflowPanelProps } from '@workbench/ui';
import type { StepPhase, StepState } from '@intx/workflow';
import type { WorkflowStep } from '@workbench/ui';

const STEP_IDS = ['intake', 'analyze', 'generate', 'approval'] as const;
type StepId = (typeof STEP_IDS)[number];

const STEP_LABELS: Record<StepId, string> = {
  intake: 'Intake',
  analyze: 'Analyze',
  generate: 'Generate',
  approval: 'Approve',
};

const APPROVAL_SIGNAL = 'artifact-approval';

const IntakeOutput = type({
  'title?': 'string',
  'summary?': 'string',
});

const AnalyzeOutput = type({
  'painPoints?': 'string[]',
});

const GenerateOutput = type({
  'collateral?': 'string',
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

function IntakeSection({ output }: { output: unknown }) {
  const parsed = IntakeOutput(output);
  if (parsed instanceof type.errors) {
    return <Pending label="Waiting for a Granola note selection…" />;
  }
  if (!parsed.title && !parsed.summary) {
    return <Pending label="Waiting for a Granola note selection…" />;
  }
  return (
    <div className="space-y-1.5">
      {parsed.title ? <p className="text-sm font-medium text-text">{parsed.title}</p> : null}
      {parsed.summary ? <p className="text-[13px] leading-relaxed text-text-2">{parsed.summary}</p> : null}
    </div>
  );
}

function AnalyzeSection({ output }: { output: unknown }) {
  const parsed = AnalyzeOutput(output);
  if (parsed instanceof type.errors || !parsed.painPoints || parsed.painPoints.length === 0) {
    return <Pending label="Pain points appear here once analysis completes." />;
  }
  return (
    <ul className="space-y-2">
      {parsed.painPoints.map((point, index) => (
        <li key={index} className="flex gap-2 text-[13px] leading-relaxed text-text-2">
          <span className="select-none text-text-3">{index + 1}.</span>
          <span>{point}</span>
        </li>
      ))}
    </ul>
  );
}

function GenerateSection({ output }: { output: unknown }) {
  const parsed = GenerateOutput(output);
  if (parsed instanceof type.errors || !parsed.collateral) {
    return <Pending label="Generated collateral appears here once it is ready." />;
  }
  return (
    <pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text-2">{parsed.collateral}</pre>
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
      <p className="text-[13px] text-text-2">Review the generated collateral above, then approve to finish the run.</p>
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
  const failed = STEP_IDS.some((id) => phaseFor(state, id) === 'failed') || state?.phase === 'failed';

  const handleApprove = () => {
    onSignal(APPROVAL_SIGNAL, { approved: true });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-panel border border-border bg-bg">
      <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-4">
        <div>
          <h2 className="text-sm font-medium text-text">Pain Point Collateral</h2>
          <p className="text-[12px] text-text-3">
            {connected ? 'Live' : 'Reconnecting…'}
          </p>
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

        <SectionCard title="Intake — selected Granola note">
          <IntakeSection output={stepOutputs.intake} />
        </SectionCard>

        <SectionCard title="Analyze — extracted pain points">
          <AnalyzeSection output={stepOutputs.analyze} />
        </SectionCard>

        <SectionCard title="Generate — collateral">
          <GenerateSection output={stepOutputs.generate} />
        </SectionCard>

        <SectionCard title="Approval">
          <ApprovalSection phase={approvalPhase} onApprove={handleApprove} />
        </SectionCard>
      </div>
    </div>
  );
}
