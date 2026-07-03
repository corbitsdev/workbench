import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import {
  AlertTriangle,
  Bell,
  Check,
  ChevronRight,
  Clipboard,
  Clock,
  Loader2,
} from "lucide-react";
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
import { ToolsFacetView, type ToolRow } from "./principal-facets";
import { humanizeToken } from "./activity-naming";
import {
  BottomNav,
  CompactHeader,
  FacetCard,
  FacetDesc,
  FacetTabs,
  GapBanner,
  NodeGrid,
  StatStrip,
  useFacetKeyboard,
  type FacetDef,
  type Stat,
  type StatusPill,
  type TraceNode,
  type TraceRoot,
} from "./tracer-shell";

const PHASE_LABEL: Record<LogStepState["phase"], string> = {
  "in-flight": "In flight",
  "awaiting-signal": "Awaiting approval",
  "awaiting-timer": "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

// Per-phase status indicator: never color-only. Each phase pairs a semantic
// token WITH a distinguishing glyph. Awaiting-signal is a genuine action gate —
// the one place the accent token is warranted; passive states stay neutral.
function PhaseIndicator({ phase }: { phase: LogStepState["phase"] }) {
  const base =
    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border";
  if (phase === "in-flight") {
    return (
      <span
        className={`${base} border-blue/40 bg-blue/10 text-blue`}
        aria-label="In flight"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
      </span>
    );
  }
  if (phase === "awaiting-signal") {
    return (
      <span
        className={`${base} border-accent/40 bg-accent/10 text-accent`}
        aria-label="Awaiting approval"
      >
        <Bell className="h-3 w-3" />
      </span>
    );
  }
  if (phase === "awaiting-timer") {
    return (
      <span
        className={`${base} border-border bg-surface-2 text-text-3`}
        aria-label="Waiting"
      >
        <Clock className="h-3 w-3" />
      </span>
    );
  }
  if (phase === "completed") {
    return (
      <span
        className={`${base} border-green/40 bg-green/10 text-green`}
        aria-label="Completed"
      >
        <Check className="h-3 w-3" />
      </span>
    );
  }
  if (phase === "failed") {
    return (
      <span
        className={`${base} border-red/40 bg-red/10 text-red`}
        aria-label="Failed"
      >
        <AlertTriangle className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span
      className={`${base} border-border bg-surface-2 text-text-3`}
      aria-label="Cancelled"
    >
      <span className="text-[11px] leading-none">×</span>
    </span>
  );
}

const STEP_TYPE_LABEL: Record<LogStepState["stepType"], string> = {
  human: "Human gate",
  agent: "Agent",
  deterministic: "Tool",
  inline: "Inline",
  other: "Step",
  unknown: "Step",
};

// Honest span: null unless BOTH boundaries are present and the span is
// non-negative (the record model never guarantees an end timestamp).
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

function copyText(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    return Promise.resolve(false);
  }
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  return (
    <button
      type="button"
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="flex items-center gap-1 rounded-[6px] border border-border px-2 py-1 text-[11px] font-medium text-text-2 transition-colors hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      {copied ? (
        <Check className="h-3 w-3 text-green" />
      ) : (
        <Clipboard className="h-3 w-3" />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
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
          aria-pressed={raw}
          className="rounded-[6px] border border-border px-2 py-1 text-[11px] font-medium text-text-2 transition-colors hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {raw ? "Pretty" : "Raw JSON"}
        </button>
        <CopyButton text={shown} />
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

/**
 * One run step, presented as a moment card in the artifact's language: a phase
 * dot/glyph, plain step label + type, an honest duration, and inline
 * decomposition (its sanitized failure, parked signal, and decoded output —
 * each behind an explicit expander). All step behavior and testids are the
 * proven CL-2728 ones; only the surrounding presentation matches the artifact.
 */
function TraceStepMoment({
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
      className="rounded-[12px] border border-border bg-surface shadow-[var(--shadow)]"
    >
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <PhaseIndicator phase={step.phase} />
          <div className="min-w-0">
            <span className="flex items-baseline gap-2">
              <span className="truncate text-[13px] font-semibold text-text">
                {index + 1}. {toHumanLabel(step.stepId)}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-text-3">
                {STEP_TYPE_LABEL[step.stepType]}
              </span>
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

      <div className="px-4 pb-3">
        {classified !== null && (
          <div className="rounded-[8px] border border-orange bg-orange-soft p-3">
            <p className="text-[12px] font-medium text-orange-deep">
              {classified.userMessage}
            </p>
            <button
              type="button"
              onClick={() => setOperatorOpen((o) => !o)}
              aria-expanded={operatorOpen}
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
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setOutputOpen((o) => !o)}
              aria-expanded={outputOpen}
              className="text-[12px] font-medium text-text-2 transition-colors hover:text-text focus-visible:outline-none"
            >
              {outputOpen ? "Hide output" : "Output"}
            </button>
            {outputOpen && <PayloadView value={output.value} />}
          </div>
        ) : (
          step.outputRef !== undefined && (
            <p className="mt-2 break-all text-[11px] text-text-3">
              Output stored out of line (too large to display): {step.outputRef}
            </p>
          )
        )}
      </div>
    </li>
  );
}

const FACETS: FacetDef[] = [
  { id: "timeline", label: "Timeline", hasGap: false },
  { id: "grants", label: "Grants", hasGap: true },
  { id: "tools", label: "Tools", hasGap: true },
  { id: "cost", label: "Cost", hasGap: true },
  { id: "connections", label: "Connections", hasGap: false },
];

/**
 * A run's tool invocations are its deterministic (tool/API-call) steps — the
 * honest per-run tool record the event log carries. Aggregated by step id into
 * call counts, mirroring the principal Tools facet so both traces read the
 * same. Retries collapse into one row; each attempt bumps the count.
 */
export function toolRowsFromSteps(steps: LogStepState[]): ToolRow[] {
  const byName = new Map<string, ToolRow>();
  for (const s of steps) {
    if (s.stepType !== "deterministic") continue;
    const existing = byName.get(s.stepId);
    if (existing !== undefined) existing.calls += s.currentAttempt;
    else {
      byName.set(s.stepId, {
        name: s.stepId,
        plain: humanizeToken(s.stepId),
        calls: s.currentAttempt,
      });
    }
  }
  return [...byName.values()].sort((a, b) => b.calls - a.calls);
}

function runStatusPill(phase: string | undefined): StatusPill {
  if (phase === "failed") return { tone: "danger", label: "Failed" };
  if (phase === "running" || phase === "in-flight") {
    return { tone: "live", label: "Running" };
  }
  if (phase === "awaiting-signal" || phase === "awaiting-timer") {
    return { tone: "warn", label: "Awaiting" };
  }
  if (phase === "completed") return { tone: "done", label: "Completed" };
  return { tone: "done", label: phase ?? "Run" };
}

/**
 * Execution trace (`/insights/trace/:runId`), rebuilt to the approved Tracer
 * artifact: a Trace-root rail + legend, a compact run header with a status
 * pill, an underlined facet tab bar over a subtle stat strip, and a
 * Back / Next-step bottom nav. The Timeline facet is the moment-walk over the
 * run's real steps (their sanitized failures and decoded outputs); Cost and
 * Grants are honest "not recorded yet" facets; Connections links the run's
 * definition/deployment. Nothing is fabricated.
 */
export function WorkflowTracePage() {
  const { runId } = useParams();
  const { activeTenantId } = useActiveWorkbench();
  const safeId = runId ?? null;
  const [facetIndex, setFacetIndex] = useState(0);
  useFacetKeyboard(facetIndex, FACETS.length, setFacetIndex);

  const recordQuery = useWorkflowRecord(safeId, activeTenantId);
  const runStateQuery = useWorkflowRunState(safeId, activeTenantId);

  const logState = runStateQuery.data;
  const record = recordQuery.data;

  const stepOutputs = useMemo<Record<string, unknown>>(
    () => (logState === undefined ? {} : stepOutputsFromLog(logState)),
    [logState],
  );

  const runError = useMemo(() => {
    if (record === undefined || logState === undefined) return null;
    return failedRunError(reconcileRunState(record, runStateFromLog(logState)));
  }, [record, logState]);

  const loading = recordQuery.isLoading || runStateQuery.isLoading;
  const steps = logState?.steps ?? [];

  const root: TraceRoot = {
    kindChip: "workflow",
    name: record !== undefined ? toHumanLabel(record.kind) : "Run trace",
    rawId: safeId ?? "—",
    tone: "run",
  };
  const status = runStatusPill(logState?.phase);

  const completed = steps.filter((s) => s.phase === "completed").length;
  const failed = steps.filter((s) => s.phase === "failed").length;
  const awaiting = steps.filter(
    (s) => s.phase === "awaiting-signal" || s.phase === "awaiting-timer",
  ).length;
  const duration = formatStepDuration(logState?.startedAt, logState?.endedAt);
  // Until the run-state query has resolved, show "—" instead of a fabricated 0
  // that reads as "no steps"; on error the step counts are likewise unknown.
  const stepsReady = runStateQuery.isSuccess;
  const stepStat = (n: number) => (stepsReady ? n.toLocaleString() : "—");
  const stats: Stat[] = [
    { label: "Steps", value: stepStat(steps.length) },
    { label: "Completed", value: stepStat(completed) },
    { label: "Failed", value: stepStat(failed) },
    { label: "Awaiting", value: stepStat(awaiting) },
    { label: "Duration", value: duration ?? "—" },
  ];

  const connectionNodes: TraceNode[] = [];
  if (record !== undefined) {
    connectionNodes.push({
      kind: "definition",
      label: toHumanLabel(record.kind),
      rawId: record.kind,
      meta: "this run was built from this definition",
    });
    if (record.deploymentId !== undefined) {
      connectionNodes.push({
        kind: "deployment",
        label: "Per-run deployment",
        rawId: record.deploymentId,
        meta: "ephemeral, 1:1 with this run",
      });
    }
  }

  const activeFacet = FACETS[facetIndex]!.id;

  return (
    <PagePanel scroll flat>
      <div className="w-full px-6 py-5 max-md:px-3">
        <main className="min-w-0 flex-1">
          <CompactHeader root={root} status={status} backTo="/insights" />

          <div className="mt-3.5">
            <FacetTabs
              facets={FACETS}
              activeId={activeFacet}
              onSelect={(fid) =>
                setFacetIndex(FACETS.findIndex((f) => f.id === fid))
              }
            />
            <StatStrip stats={stats} />
          </div>

          <section className="mt-3">
            {loading && (
              <div className="flex flex-col gap-3" data-testid="trace-loading">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-[64px] animate-pulse rounded-[12px] bg-surface-2"
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

            {!loading && !recordQuery.isError && activeFacet === "timeline" && (
              <div className="flex flex-col gap-3">
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
                    Per-step detail isn&rsquo;t available for this run (it
                    predates step-level tracing, or its event log couldn&rsquo;t
                    be read).
                  </div>
                )}

                {!runStateQuery.isError && steps.length === 0 && (
                  <div className="rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
                    No steps have been recorded for this run yet.
                  </div>
                )}

                {steps.length > 0 && (
                  <>
                    <p className="flex items-center gap-2 text-[11.5px] text-text-3">
                      <ChevronRight className="h-3 w-3" />
                      Each step is a moment — open its output or failure to step
                      into it.
                    </p>
                    <ol
                      role="status"
                      aria-live="polite"
                      className="flex flex-col gap-2.5"
                    >
                      {steps.map((step, index) => (
                        <TraceStepMoment
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
                  </>
                )}
              </div>
            )}

            {!loading && !recordQuery.isError && activeFacet === "cost" && (
              <div>
                <FacetDesc>
                  Token classes for this run are kept separate and priced
                  independently.
                </FacetDesc>
                <GapBanner ticket="CL-2723">
                  Per-run token counts aren&rsquo;t attributed to this trace
                  yet, and the dollar layer isn&rsquo;t wired into analytics —
                  so no cost is shown rather than a fabricated one.
                </GapBanner>
              </div>
            )}

            {!loading && !recordQuery.isError && activeFacet === "grants" && (
              <div>
                <FacetDesc>
                  Permissions this run exercised, and whether each was allowed.
                </FacetDesc>
                <GapBanner ticket="CL-2722">
                  Which grant authorized each step isn&rsquo;t persisted yet, so
                  a per-run permission table would be fabricated. The
                  run&rsquo;s steps and their outcomes are the honest record
                  above.
                </GapBanner>
              </div>
            )}

            {!loading && !recordQuery.isError && activeFacet === "tools" && (
              <ToolsFacetView
                tools={toolRowsFromSteps(steps)}
                description="Every tool step this run invoked and how often. The concrete data each call touched is the gap."
                emptyText="No tool steps recorded for this run."
              />
            )}

            {!loading &&
              !recordQuery.isError &&
              activeFacet === "connections" && (
                <div>
                  <FacetDesc>
                    The definition and deployment this run is linked to.
                  </FacetDesc>
                  {connectionNodes.length === 0 ? (
                    <FacetCard>
                      <p className="text-[13px] text-text-2">
                        No linked entities recorded for this run.
                      </p>
                    </FacetCard>
                  ) : (
                    <NodeGrid nodes={connectionNodes} />
                  )}
                </div>
              )}
          </section>

          <BottomNav
            index={facetIndex}
            total={FACETS.length}
            onPrev={() => setFacetIndex(Math.max(0, facetIndex - 1))}
            onNext={() =>
              setFacetIndex(Math.min(FACETS.length - 1, facetIndex + 1))
            }
          />
        </main>
      </div>
    </PagePanel>
  );
}
