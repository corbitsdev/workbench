import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { motion, useReducedMotion, type Variants } from "framer-motion";
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
import { usePublishActiveContext } from "../../lib/active-context-store";
import { WORKFLOW_STEP_OUTPUT_MAX_CHARS } from "@workbench/shared";
import {
  reconcileRunState,
  runStateFromLog,
  useWorkflowRecord,
  useWorkflowRunState,
  useWorkflowRunTokens,
} from "../../hooks/use-workflow";
import {
  stepOutputsFromLog,
  type LogStepState,
} from "../../lib/run-state-adapter";
import { ToolsFacetView, type ToolRow } from "./principal-facets";
import { humanizeToken } from "./activity-naming";
import {
  CompactHeader,
  FacetCard,
  FacetDesc,
  FacetTabs,
  GapBanner,
  NodeGrid,
  StatStrip,
  type FacetDef,
  type Stat,
  type StatusPill,
  type TraceNode,
  type TraceRoot,
  TracerFacetNav,
} from "./tracer-shell";
import {
  clampListIndex,
  stepListIndexOnKeyDown,
  useScrollListboxOption,
} from "./moment-listbox";

// Light staggered fade for the timeline steps as they mount, matching the
// dashboard's section entrance. Reduced-motion collapses it to an instant show
// (the container's initial is set to false in that case).
const STEP_CONTAINER: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04, delayChildren: 0.02 } },
};
const STEP_ITEM: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2, ease: "easeOut" } },
};

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
      className="flex min-h-[40px] items-center gap-1 rounded-sm border border-border px-2 py-1 text-[11px] font-medium text-text-2 transition-[color,background-color,transform] hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97]"
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
          className="min-h-[40px] rounded-sm border border-border px-2 py-1 text-[11px] font-medium text-text-2 transition-[color,background-color,transform] hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97]"
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
  stepTokens,
  isSelected,
  onSelect,
  optionId,
}: {
  step: LogStepState;
  index: number;
  output: { value: unknown } | null;
  stepTokens?: { inputTokens: number; outputTokens: number } | null;
  isSelected: boolean;
  onSelect: () => void;
  optionId: string;
}) {
  const [operatorOpen, setOperatorOpen] = useState(false);
  const duration = formatStepDuration(step.startedAt, step.endedAt);
  const classified =
    step.lastError !== undefined
      ? classifyRunError(step.lastError.message)
      : null;

  return (
    <motion.li
      variants={STEP_ITEM}
      role="option"
      id={optionId}
      aria-selected={isSelected}
      data-testid="trace-step"
      data-phase={step.phase}
      className={`cursor-pointer rounded border bg-surface shadow-[var(--shadow-card)] outline-none transition-[border-color,box-shadow] focus-within:ring-1 focus-within:ring-accent ${
        isSelected
          ? "border-accent/50 ring-1 ring-accent/30"
          : "border-border hover:border-border"
      }`}
      onClick={onSelect}
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
          {stepTokens !== undefined && stepTokens !== null && (
            <span
              data-testid="trace-step-tokens"
              className="font-mono text-[10px] tabular-nums text-text-3"
            >
              {stepTokens.inputTokens.toLocaleString()} in /{" "}
              {stepTokens.outputTokens.toLocaleString()} out
            </span>
          )}
        </div>
      </div>

      {isSelected && (
        <div className="px-4 pb-3" data-testid="trace-step-decomposition">
          {classified !== null && (
            <div className="rounded-sm border border-red bg-red-soft p-3">
              <p className="text-[12px] font-medium text-red-deep">
                {classified.userMessage}
              </p>
              <button
                type="button"
                onClick={() => setOperatorOpen((o) => !o)}
                aria-expanded={operatorOpen}
                className="mt-2 text-[11px] font-medium text-red-deep underline-offset-2 hover:underline focus-visible:outline-none"
              >
                {operatorOpen ? "Hide operator details" : "Operator details"}
              </button>
              {operatorOpen && (
                <pre
                  data-testid="trace-operator-details"
                  className="mt-2 max-h-[280px] overflow-auto rounded-sm border border-red bg-surface p-2 font-mono text-[11px] leading-relaxed text-text-2"
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
              <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-text-3">
                Output
              </p>
              <PayloadView value={output.value} />
            </div>
          ) : (
            step.outputRef !== undefined && (
              <p className="mt-2 break-all text-[11px] text-text-3">
                Output stored out of line (too large to display):{" "}
                {step.outputRef}
              </p>
            )
          )}
        </div>
      )}
    </motion.li>
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
    return { tone: "progress", label: "Running" };
  }
  if (phase === "awaiting-signal" || phase === "awaiting-timer") {
    return { tone: "attention", label: "Awaiting" };
  }
  if (phase === "completed") return { tone: "positive", label: "Completed" };
  return { tone: "neutral", label: phase ?? "Run" };
}

/**
 * Coerce a raw step output (unknown from the log) into a short string for the
 * active-context projection. Bounds both the string and object forms and guards
 * against the JSON.stringify throw (circular refs, Symbol, BigInt). The
 * projector bounds it further; this only ensures a readable scalar and never
 * dumps a large value verbatim.
 */
function truncateStepOutput(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "string") {
    return raw.length > 0
      ? raw.slice(0, WORKFLOW_STEP_OUTPUT_MAX_CHARS)
      : undefined;
  }
  try {
    const text =
      JSON.stringify(raw)?.slice(0, WORKFLOW_STEP_OUTPUT_MAX_CHARS) ?? "";
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
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
  const reduceMotion = useReducedMotion();
  const safeId = runId ?? null;
  const [facetIndex, setFacetIndex] = useState(0);

  const recordQuery = useWorkflowRecord(safeId, activeTenantId);
  const runStateQuery = useWorkflowRunState(safeId, activeTenantId);
  const tokensQuery = useWorkflowRunTokens(safeId, activeTenantId);

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
  const timelineListRef = useRef<HTMLUListElement>(null);
  const [selectedStep, setSelectedStep] = useState(0);
  const clampedStepIndex = clampListIndex(selectedStep, steps.length);
  useScrollListboxOption(
    timelineListRef,
    (index) => `run-step-${index}`,
    clampedStepIndex,
  );

  const stepTokenMap = useMemo(() => {
    const map = new Map<
      string,
      { inputTokens: number; outputTokens: number }
    >();
    for (const row of tokensQuery.data?.steps ?? []) {
      map.set(row.stepId, {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
      });
    }
    return map;
  }, [tokensQuery.data?.steps]);

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

  // Publish the traced run as the active surface (CL-2726) so the Myra popup can
  // attach it as context. Reuses the workflow-run kind — this IS a workflow run,
  // viewed from the tracer. Published only once the record AND the run-state log
  // resolve, so the projection carries real identity and steps, not a loading
  // placeholder with an empty step list.
  usePublishActiveContext(
    record !== undefined && logState !== undefined && safeId !== null
      ? {
          kind: "workflow-run",
          id: safeId,
          label: toHumanLabel(record.kind),
          runKind: record.kind,
          status: logState.phase ?? record.status,
          steps: steps.map((s) => ({
            name: s.stepId,
            status: s.phase,
            output: truncateStepOutput(stepOutputs[s.stepId]),
          })),
        }
      : null,
    record !== undefined && logState !== undefined
      ? // Fold the run phase and each step's phase into the freshness token so a
        // live run re-publishes as steps transition (running → completed/failed)
        // and outputs fill in — keying on `steps.length` alone kept the first,
        // stale snapshot for the whole run (CL-2726 review).
        `${safeId}:${logState.phase ?? ""}:${steps
          .map((s) => `${s.stepId}=${s.phase}`)
          .join(",")}`
      : undefined,
  );

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
                    className="flex items-start gap-2 rounded-sm border border-red bg-red-soft p-3"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-deep" />
                    <p className="text-[13px] text-red-deep">
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
                      Step through moments with ↑ ↓ — the selected step expands
                      inline.
                    </p>
                    <motion.ul
                      ref={timelineListRef}
                      role="listbox"
                      aria-label="Run steps"
                      aria-activedescendant={`run-step-${clampedStepIndex}`}
                      tabIndex={0}
                      onKeyDown={(event) => {
                        const next = stepListIndexOnKeyDown(
                          event,
                          clampedStepIndex,
                          steps.length,
                        );
                        if (next !== null) setSelectedStep(next);
                      }}
                      className="flex flex-col gap-2.5 outline-none focus-visible:ring-1 focus-visible:ring-accent"
                      variants={STEP_CONTAINER}
                      initial={reduceMotion ? false : "hidden"}
                      animate="show"
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
                          stepTokens={stepTokenMap.get(step.stepId) ?? null}
                          isSelected={index === clampedStepIndex}
                          onSelect={() => setSelectedStep(index)}
                          optionId={`run-step-${index}`}
                        />
                      ))}
                    </motion.ul>
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
                {tokensQuery.isLoading && (
                  <div className="h-[64px] animate-pulse rounded-[12px] bg-surface-2" />
                )}
                {!tokensQuery.isLoading &&
                  (tokensQuery.isError ||
                    tokensQuery.data?.available !== true) && (
                    <GapBanner>
                      {tokensQuery.isError
                        ? "Per-run token counts couldn't be loaded for this trace."
                        : "Per-run token counts aren't attributed to this run yet — either no inference has landed for it, or (for a run that predates per-run deployments) its usage collapsed into a later run sharing the same deployment."}{" "}
                      The dollar layer isn&rsquo;t wired into analytics yet
                      either, so no cost is shown rather than a fabricated one.
                    </GapBanner>
                  )}
                {!tokensQuery.isLoading &&
                  !tokensQuery.isError &&
                  tokensQuery.data?.available === true &&
                  tokensQuery.data.totals !== undefined && (
                    <FacetCard title="Token totals">
                      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px] sm:grid-cols-3">
                        {(
                          [
                            ["Input", tokensQuery.data.totals.inputTokens],
                            ["Output", tokensQuery.data.totals.outputTokens],
                            [
                              "Cache read",
                              tokensQuery.data.totals.cacheReadTokens,
                            ],
                            [
                              "Cache write",
                              tokensQuery.data.totals.cacheWriteTokens,
                            ],
                            [
                              "Thinking",
                              tokensQuery.data.totals.thinkingTokens,
                            ],
                            ["Turns", tokensQuery.data.totals.turnCount],
                          ] as const
                        ).map(([label, value]) => (
                          <div key={label}>
                            <dt className="font-mono text-[9px] uppercase tracking-[0.09em] text-text-3">
                              {label}
                            </dt>
                            <dd className="text-[13px] font-bold tabular-nums tracking-[-0.01em] text-text">
                              {value.toLocaleString()}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </FacetCard>
                  )}
                {!tokensQuery.isLoading &&
                  !tokensQuery.isError &&
                  tokensQuery.data?.available === true &&
                  (tokensQuery.data.steps?.length ?? 0) > 0 && (
                    <div className="mt-3">
                      <FacetCard title="By step">
                        <table className="w-full text-left text-[12px]">
                          <thead>
                            <tr className="font-mono text-[9px] uppercase tracking-[0.09em] text-text-3">
                              <th className="pb-2 font-normal">Step</th>
                              <th className="pb-2 text-right font-normal">
                                Input
                              </th>
                              <th className="pb-2 text-right font-normal">
                                Output
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {(tokensQuery.data.steps ?? []).map((row) => (
                              <tr
                                key={row.stepId}
                                className="border-t border-border"
                              >
                                <td className="py-2 text-text">
                                  {toHumanLabel(row.stepId)}
                                </td>
                                <td className="py-2 text-right tabular-nums text-text-2">
                                  {row.inputTokens.toLocaleString()}
                                </td>
                                <td className="py-2 text-right tabular-nums text-text-2">
                                  {row.outputTokens.toLocaleString()}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </FacetCard>
                    </div>
                  )}
              </div>
            )}

            {!loading && !recordQuery.isError && activeFacet === "grants" && (
              <div>
                <FacetDesc>
                  Permissions this run exercised, and whether each was allowed.
                </FacetDesc>
                <GapBanner>
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

          <TracerFacetNav
            backTo="/insights"
            facets={FACETS}
            activeIndex={facetIndex}
            onFacetIndexChange={setFacetIndex}
          />
        </main>
      </div>
    </PagePanel>
  );
}
