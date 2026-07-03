import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { AlertTriangle, ChevronLeft, Clipboard } from "lucide-react";
import {
  PagePanel,
  classifyRunError,
  failedRunError,
  toHumanLabel,
} from "@workbench/ui";
import { useActiveWorkbench } from "../../lib/active-workbench-context";
import {
  reconcileRunState,
  runStateFromLog,
  useWorkflowRecord,
  useWorkflowRunState,
} from "../../hooks/use-workflow";
import {
  stepOutputsFromLog,
  type LogStepState,
} from "../../lib/run-state-adapter";

// Log-derived per-step phase → operator-facing label + status-dot color. Keyed
// on the raw `LogStepState.phase` union (same vocabulary the runtime records).
const PHASE_LABEL: Record<LogStepState["phase"], string> = {
  "in-flight": "In flight",
  "awaiting-signal": "Awaiting approval",
  "awaiting-timer": "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const PHASE_DOT: Record<LogStepState["phase"], string> = {
  "in-flight": "bg-orange",
  "awaiting-signal": "bg-orange",
  "awaiting-timer": "bg-orange",
  completed: "bg-green-500",
  failed: "bg-red-500",
  cancelled: "bg-border-strong",
};

const STEP_TYPE_LABEL: Record<LogStepState["stepType"], string> = {
  human: "Human gate",
  agent: "Agent",
  deterministic: "Tool",
  inline: "Inline",
  other: "Step",
  unknown: "Step",
};

// Honest span duration: null unless BOTH boundaries are present and the span is
// non-negative (the record model never guarantees an end timestamp — an
// in-flight or interrupted step has none, and we must not invent one).
export function formatStepDuration(
  startedAt: string | undefined,
  endedAt: string | undefined,
): string | null {
  if (startedAt === undefined || endedAt === undefined) return null;
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function copyText(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    void navigator.clipboard.writeText(text).catch(() => undefined);
  }
}

function PayloadView({ value }: { value: unknown }) {
  const [raw, setRaw] = useState(false);
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  const compact = useMemo(() => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }, [value]);
  const shown = raw ? compact : pretty;

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setRaw((r) => !r)}
          className="rounded-[6px] border border-border px-2 py-1 text-[11px] font-medium text-text-2 transition-colors hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {raw ? "Pretty" : "Raw JSON"}
        </button>
        <button
          type="button"
          onClick={() => copyText(shown)}
          className="flex items-center gap-1 rounded-[6px] border border-border px-2 py-1 text-[11px] font-medium text-text-2 transition-colors hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <Clipboard className="h-3 w-3" />
          Copy
        </button>
      </div>
      <pre
        data-testid="trace-payload"
        className="max-h-[420px] overflow-auto rounded-[8px] border border-border bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-text-2"
      >
        {shown}
      </pre>
    </div>
  );
}

function TraceStepRow({
  step,
  index,
  output,
}: {
  step: LogStepState;
  index: number;
  output: { value: unknown } | null;
}) {
  const [outputOpen, setOutputOpen] = useState(false);
  const [operatorOpen, setOperatorOpen] = useState(false);
  const duration = formatStepDuration(step.startedAt, step.endedAt);
  const classified =
    step.lastError !== undefined
      ? classifyRunError(step.lastError.message)
      : null;

  return (
    <li
      data-testid="trace-step"
      data-phase={step.phase}
      className="rounded-[10px] border border-border bg-surface px-4 py-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${PHASE_DOT[step.phase]}`}
          />
          <div className="min-w-0">
            <span className="block truncate text-[13px] font-medium text-text">
              {index + 1}. {toHumanLabel(step.stepId)}
            </span>
            <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-text-3">
              {STEP_TYPE_LABEL[step.stepType]}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="text-[12px] font-medium text-text-2">
            {PHASE_LABEL[step.phase]}
          </span>
          {duration !== null && (
            <span
              data-testid="trace-step-duration"
              className="font-mono text-[11px] tabular-nums text-text-3"
            >
              {duration}
            </span>
          )}
          {step.currentAttempt > 1 && (
            <span className="text-[10px] uppercase tracking-[0.08em] text-text-3">
              Attempt {step.currentAttempt}
            </span>
          )}
        </div>
      </div>

      {classified !== null && (
        <div className="mt-3 rounded-[8px] border border-orange bg-orange-soft p-3">
          <p className="text-[12px] font-medium text-orange-deep">
            {classified.userMessage}
          </p>
          <button
            type="button"
            onClick={() => setOperatorOpen((o) => !o)}
            className="mt-2 text-[11px] font-medium text-orange-deep underline-offset-2 hover:underline focus-visible:outline-none"
          >
            {operatorOpen ? "Hide operator details" : "Operator details"}
          </button>
          {operatorOpen && (
            <pre
              data-testid="trace-operator-details"
              className="mt-2 max-h-[280px] overflow-auto rounded-[6px] border border-orange bg-surface p-2 font-mono text-[11px] leading-relaxed text-text-2"
            >
              {step.lastError?.message}
            </pre>
          )}
        </div>
      )}

      {step.awaitingSignalName !== undefined && (
        <p className="mt-2 text-[12px] text-text-3">
          Parked on signal:{" "}
          <span className="font-mono">{step.awaitingSignalName}</span>
        </p>
      )}

      {output !== null ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setOutputOpen((o) => !o)}
            className="text-[12px] font-medium text-text-2 transition-colors hover:text-text focus-visible:outline-none"
          >
            {outputOpen ? "Hide output" : "Output"}
          </button>
          {outputOpen && <PayloadView value={output.value} />}
        </div>
      ) : (
        step.outputRef !== undefined && (
          <p className="mt-3 break-all text-[11px] text-text-3">
            Output stored out of line (too large to display): {step.outputRef}
          </p>
        )
      )}
    </li>
  );
}

function TraceHeader({ runId }: { runId: string }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-3 max-md:px-3">
      <Link
        to="/insights"
        className="flex min-h-[32px] items-center gap-1 rounded-[8px] px-2 py-1.5 text-[12px] font-medium text-text-3 transition-colors hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Insights
      </Link>
      <div className="min-w-0">
        <p className="text-[14px] font-semibold text-text">Run trace</p>
        <p className="truncate font-mono text-[11px] text-text-3">{runId}</p>
      </div>
    </div>
  );
}

export function WorkflowTracePage() {
  const { runId } = useParams();
  const { activeTenantId } = useActiveWorkbench();
  const safeId = runId ?? null;

  const recordQuery = useWorkflowRecord(safeId, activeTenantId);
  const runStateQuery = useWorkflowRunState(safeId, activeTenantId);

  const logState = runStateQuery.data;
  const record = recordQuery.data;

  const stepOutputs = useMemo<Record<string, unknown>>(() => {
    if (logState === undefined) return {};
    try {
      return stepOutputsFromLog(logState);
    } catch {
      // A malformed inline payload must not blank the whole trace — the raw ref
      // still renders per step. Degrade to no decoded outputs.
      return {};
    }
  }, [logState]);

  const runError = useMemo(() => {
    if (record === undefined || logState === undefined) return null;
    return failedRunError(reconcileRunState(record, runStateFromLog(logState)));
  }, [record, logState]);

  const loading = recordQuery.isLoading || runStateQuery.isLoading;
  const steps = logState?.steps ?? [];

  return (
    <PagePanel scroll={false} flat>
      <TraceHeader runId={safeId ?? "—"} />
      <div className="flex-1 overflow-y-auto px-5 py-5 max-md:px-3">
        {loading && (
          <div className="flex flex-col gap-3" data-testid="trace-loading">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[64px] animate-pulse rounded-[10px] bg-surface-2"
              />
            ))}
          </div>
        )}

        {!loading && recordQuery.isError && (
          <div className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
            Couldn&rsquo;t load this run. It may have been archived, or you
            don&rsquo;t have access to it.
          </div>
        )}

        {!loading && !recordQuery.isError && (
          <div className="mx-auto flex max-w-[820px] flex-col gap-4">
            {record !== undefined && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-[6px] border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-2">
                  {toHumanLabel(record.kind)}
                </span>
                <span className="text-[12px] text-text-3">
                  {steps.length} step{steps.length === 1 ? "" : "s"}
                </span>
              </div>
            )}

            {runError !== null && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-[10px] border border-orange bg-orange-soft p-3"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-deep" />
                <p className="text-[13px] text-orange-deep">
                  {runError.userMessage}
                </p>
              </div>
            )}

            {runStateQuery.isError && (
              <div className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
                Per-step detail isn&rsquo;t available for this run (it predates
                step-level tracing, or its event log couldn&rsquo;t be read).
              </div>
            )}

            {!runStateQuery.isError && steps.length === 0 && (
              <div className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
                No steps have been recorded for this run yet.
              </div>
            )}

            {steps.length > 0 && (
              <ol className="flex flex-col gap-2.5">
                {steps.map((step, index) => (
                  <TraceStepRow
                    key={step.stepId}
                    step={step}
                    index={index}
                    output={
                      step.stepId in stepOutputs
                        ? { value: stepOutputs[step.stepId] }
                        : null
                    }
                  />
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </PagePanel>
  );
}
