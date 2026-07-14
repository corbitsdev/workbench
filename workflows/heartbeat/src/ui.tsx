import { type } from "arktype";
import type { RunState, StepState } from "@intx/workflow";
import { heartbeatIntakeStepKey, WIRED_BRIEF_SOURCES } from "@workbench/shared";
import {
  activeDisplayStep,
  buildRunStepperSteps,
  Button,
  type DisplayStep,
  FailedRunNotice,
  HorizontalStepper,
  liveStatusLabel,
  LiveStatusSlot,
  Markdown,
  type WorkflowPanelProps,
  type WorkflowStep,
} from "@workbench/ui";

// Scheduler-fired and gate-free: this panel is a read-only run view. It has no
// launch inputs and fires no signals — it reports the steps' progress and
// renders the delivered brief once it is written. Intake step ids are derived
// from the wired brief-source catalog, matching how the workflow generates them.
const INTAKE_STEP_IDS = WIRED_BRIEF_SOURCES.map((source) =>
  heartbeatIntakeStepKey(source.key),
);

const DISPLAY_STEPS: DisplayStep[] = [
  { key: "intake", label: "Sources", stepIds: [...INTAKE_STEP_IDS] },
  {
    key: "brief",
    label: "Brief",
    stepIds: ["brief"],
    activityLabel: "Writing your brief",
  },
  {
    key: "save",
    label: "Save",
    stepIds: ["persist"],
    activityLabel: "Saving to your workbench",
  },
  {
    key: "notify",
    label: "Deliver",
    stepIds: ["notify"],
    activityLabel: "Sending to your inbox",
  },
];

const ALL_STEP_IDS = [...INTAKE_STEP_IDS, "brief", "persist", "notify"];

const BriefOutput = type({ reply: "string" });

type StepPhase = StepState["phase"];

function phaseFor(state: RunState | null, id: string): StepPhase | undefined {
  return state?.steps.get(id)?.phase;
}

function hasFailed(state: RunState | null): boolean {
  if (!state) return false;
  if (state.phase === "failed") return true;
  for (const id of ALL_STEP_IDS) {
    if (phaseFor(state, id) === "failed") return true;
  }
  return false;
}

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  return buildRunStepperSteps(state, DISPLAY_STEPS);
}

/** The brief markdown once the inline-inference step has produced it, else null. */
function briefMarkdown(stepOutputs: Record<string, unknown>): string | null {
  const parsed = BriefOutput(stepOutputs.brief);
  if (parsed instanceof type.errors) return null;
  const trimmed = parsed.reply.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function deliveryStatus(state: RunState | null): string {
  if (phaseFor(state, "notify") === "completed") {
    return "Sent to your inbox and saved to your workbench.";
  }
  if (phaseFor(state, "persist") === "completed") {
    return "Saved to your workbench. Sending to your inbox…";
  }
  return "Saving and delivering…";
}

function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-[14px] border border-border bg-surface p-5 shadow-sm ${className ?? ""}`}
    >
      {children}
    </section>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-text-3">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-text-3" />
      {label}
    </div>
  );
}

function PreparingCard({ state }: { state: RunState | null }) {
  const active = activeDisplayStep(state, DISPLAY_STEPS);
  const label =
    active?.key === "intake"
      ? "Gathering your sources…"
      : "Writing your brief…";
  return (
    <Card>
      <h3 className="mb-3 text-[14px] font-semibold text-text">
        Preparing your morning brief
      </h3>
      <Spinner label={label} />
    </Card>
  );
}

function BriefCard({ markdown, status }: { markdown: string; status: string }) {
  return (
    <div className="space-y-4">
      <Card>
        <Markdown>{markdown}</Markdown>
      </Card>
      <p className="px-1 text-[12px] text-text-3">{status}</p>
    </div>
  );
}

export function Panel(props: WorkflowPanelProps) {
  const { state, connected, stepOutputs, onClose } = props;

  const failed = hasFailed(state);
  const markdown = briefMarkdown(stepOutputs);
  const liveLabel = failed ? null : liveStatusLabel(state, DISPLAY_STEPS);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-text">
            Morning brief
          </p>
          <p className="mt-px text-[11px] text-text-3">
            {connected ? "Live" : "Reconnecting…"}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close panel"
        >
          Close
        </Button>
      </header>

      <HorizontalStepper steps={buildStepperSteps(state)} />
      <LiveStatusSlot label={liveLabel} />

      <div className="flex-1 overflow-y-auto p-5">
        {failed ? (
          <FailedRunNotice
            state={state}
            steps={DISPLAY_STEPS}
            logRead={props.logRead}
          />
        ) : markdown !== null ? (
          <BriefCard markdown={markdown} status={deliveryStatus(state)} />
        ) : (
          <PreparingCard state={state} />
        )}
      </div>
    </div>
  );
}
