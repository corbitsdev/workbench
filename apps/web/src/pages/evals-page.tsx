// Evals (CL-6465): every recorded eval run in `packages/evals`'s own
// store — a run of `bun run eval` against a real Myra deployment, its
// steps, and each step's scorer reports. This is the harness's history,
// not a live production trace — `packages/evals/src/routes.ts`'s own
// header comment says eval runs aren't tenant-owned, so a tenant only
// gates the read (same non-partitioned shape as insights). There is no
// route to start a run from the UI (the harness is a `bun run eval` CLI
// step), so this page is read-only: no "Re-run" action, since a control
// that cannot actually do anything is worse than no control.
//
// "Kind" (agent run / routine / workflow) from the shell mock has no
// backing field on `EvalRunResult` — every recorded run is just "an
// eval" — so the filter row here is the real dimensions instead: which
// eval, and whether any scorer failed.

import {
  Badge,
  FilterChip,
  PageShell,
  RichEmptyState,
  RUN_STATUS_TONE,
  Skeleton,
  StatGrid,
  StatGridItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import { ListBullets } from "@corbits/icons";
import { useMemo, useState, type KeyboardEvent } from "react";

import { durationLabel } from "@corbits/insights/client";
import { SignedOutNotice } from "@corbits/api-query";

import { useAPIQuery } from "../api";
import { useBench } from "../bench-context";
import {
  evalRunDurationMs,
  evalRunOutcome,
  evalRunPath,
  evalRunsPath,
  EvalRunDetailSchema,
  EvalRunsResponseSchema,
  type EvalRunDetail,
  type EvalRunSummary,
  type EvalStepRecord,
} from "../evals-api";
import { EVALS_PATH_PREFIX } from "../path-ids";
import { parseEvalsPath } from "../evals-path";
import { useNavigate } from "../navigation";
import { StageTopBar } from "../shell/stage-top-bar";

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function durationOf(run: {
  readonly startedAt: string;
  readonly finishedAt: string;
}): string {
  const ms = evalRunDurationMs(run);
  return ms === null ? "—" : durationLabel(ms);
}

function outcomeBadge(tally: EvalRunSummary["scorerTally"]) {
  const outcome = evalRunOutcome(tally);
  const tone =
    outcome === "passed" ? RUN_STATUS_TONE.completed : RUN_STATUS_TONE.failed;
  const label = outcome === "passed" ? "Passed" : "Failed";
  return <Badge tone={tone}>{label}</Badge>;
}

function onRowActivate(onActivate: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    className: "cursor-pointer",
    onClick: onActivate,
    onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate();
      }
    },
  };
}

/** Every distinct `evalName` present in the fetched page, in first-seen
 * order — the real filter dimension the shell mock's "kind" chips stand
 * in for here. */
function evalNamesInView(runs: readonly EvalRunSummary[]): readonly string[] {
  const seen: string[] = [];
  for (const run of runs) {
    if (!seen.includes(run.evalName)) seen.push(run.evalName);
  }
  return seen;
}

function EvalsList({
  runs,
  loading,
  onOpenRun,
}: {
  readonly runs: readonly EvalRunSummary[];
  readonly loading: boolean;
  readonly onOpenRun: (id: string) => void;
}) {
  const [evalFilter, setEvalFilter] = useState<string | null>(null);
  const [failedOnly, setFailedOnly] = useState(false);
  const names = useMemo(() => evalNamesInView(runs), [runs]);

  const filtered = runs.filter((run) => {
    if (evalFilter !== null && run.evalName !== evalFilter) return false;
    if (failedOnly && evalRunOutcome(run.scorerTally) !== "failed")
      return false;
    return true;
  });

  const passed = runs.filter(
    (r) => evalRunOutcome(r.scorerTally) === "passed",
  ).length;
  const failed = runs.length - passed;

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <RichEmptyState
        icon={<ListBullets />}
        title="No eval runs yet"
        description="Runs recorded by `bun run eval` show up here — each one a full step-by-step transcript with scorer verdicts."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <StatGrid columns={3}>
        <StatGridItem label="Runs" value={String(runs.length)} />
        <StatGridItem label="Passed" value={String(passed)} />
        <StatGridItem
          label="Failed"
          value={String(failed)}
          danger={failed > 0}
        />
      </StatGrid>

      <div className="flex flex-wrap items-center gap-2">
        <FilterChip
          selected={evalFilter === null}
          onClick={() => setEvalFilter(null)}
        >
          All evals
        </FilterChip>
        {names.map((name) => (
          <FilterChip
            key={name}
            selected={evalFilter === name}
            onClick={() => setEvalFilter(name)}
          >
            {name}
          </FilterChip>
        ))}
        <FilterChip
          selected={failedOnly}
          onClick={() => setFailedOnly((v) => !v)}
        >
          Failed only
        </FilterChip>
      </div>

      {filtered.length === 0 ? (
        <RichEmptyState
          icon={<ListBullets />}
          title="No runs match this filter"
          description="Clear a filter to see more runs."
        />
      ) : (
        <Table aria-label="Eval runs">
          <TableHeader>
            <TableRow>
              <TableHead>Eval</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Steps</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((run) => (
              <TableRow
                key={run.id}
                {...onRowActivate(() => onOpenRun(run.id))}
              >
                <TableCell>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-semibold">
                      {run.evalName}
                    </span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {run.configName}
                    </span>
                  </div>
                </TableCell>
                <TableCell>{outcomeBadge(run.scorerTally)}</TableCell>
                <TableCell className="tabular-nums">{run.stepCount}</TableCell>
                <TableCell className="tabular-nums">
                  {durationOf(run)}
                </TableCell>
                <TableCell className="tabular-nums">
                  {formatWhen(run.startedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function ScorerReportRow({
  report,
}: {
  readonly report: EvalStepRecord["scorerReports"][number];
}) {
  const tone =
    report.skipped === true
      ? "neutral"
      : report.pass
        ? RUN_STATUS_TONE.completed
        : RUN_STATUS_TONE.failed;
  const label =
    report.skipped === true ? "Skipped" : report.pass ? "Pass" : "Fail";
  return (
    <div className="flex items-start justify-between gap-3 border-t border-border py-2 first:border-t-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold">{report.name}</span>
        <span className="text-xs text-muted-foreground">{report.reason}</span>
      </div>
      <Badge tone={tone}>{label}</Badge>
    </div>
  );
}

function ToolCallRow({
  call,
}: {
  readonly call: EvalStepRecord["turn"]["toolCalls"][number];
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs">
      <span className="font-semibold">{call.name}</span>
      <Badge tone={call.isError ? RUN_STATUS_TONE.failed : "neutral"}>
        {call.isError ? "error" : "ok"}
      </Badge>
    </div>
  );
}

function EvalStepPanel({ step }: { readonly step: EvalStepRecord }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
          Step {step.stepIndex + 1}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
          Prompt
        </span>
        <p className="text-sm">{step.turn.human}</p>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
          Reply
        </span>
        <p className="whitespace-pre-wrap text-sm">{step.turn.replyText}</p>
      </div>
      {step.turn.toolCalls.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
            Tool calls
          </span>
          {step.turn.toolCalls.map((call, i) => (
            <ToolCallRow key={i} call={call} />
          ))}
        </div>
      ) : null}
      {step.scorerReports.length > 0 ? (
        <div className="flex flex-col">
          <span className="mb-1 text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
            Scorers
          </span>
          {step.scorerReports.map((report, i) => (
            <ScorerReportRow key={i} report={report} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EvalRunDetailView({ run }: { readonly run: EvalRunDetail }) {
  const passed = run.steps.reduce(
    (n, s) =>
      n + s.scorerReports.filter((r) => r.pass && r.skipped !== true).length,
    0,
  );
  const failed = run.steps.reduce(
    (n, s) =>
      n + s.scorerReports.filter((r) => !r.pass && r.skipped !== true).length,
    0,
  );

  return (
    <div className="flex flex-col gap-4">
      <StatGrid columns={4}>
        <StatGridItem label="Steps" value={String(run.steps.length)} />
        <StatGridItem label="Scorers passed" value={String(passed)} />
        <StatGridItem
          label="Scorers failed"
          value={String(failed)}
          danger={failed > 0}
        />
        <StatGridItem label="Duration" value={durationOf(run)} />
      </StatGrid>
      {run.evalDescription !== null ? (
        <p className="text-sm text-muted-foreground">{run.evalDescription}</p>
      ) : null}
      <div className="flex flex-col gap-3">
        {run.steps.map((step) => (
          <EvalStepPanel key={step.stepIndex} step={step} />
        ))}
      </div>
    </div>
  );
}

export function EvalsRoute({ path }: { readonly path?: string }) {
  const { selectedTenantId } = useBench();
  const navigate = useNavigate();
  const currentPath =
    path ??
    (typeof window !== "undefined"
      ? window.location.pathname
      : EVALS_PATH_PREFIX);
  const { mode, runId } = parseEvalsPath(currentPath);

  const runs = useAPIQuery(
    selectedTenantId === null ? "" : evalRunsPath(selectedTenantId, null),
    EvalRunsResponseSchema,
  );
  const runDetail = useAPIQuery(
    mode !== "run" || selectedTenantId === null || runId === null
      ? ""
      : evalRunPath(selectedTenantId, runId),
    EvalRunDetailSchema,
  );

  if (mode === "run" && runId !== null) {
    const summary =
      runs.kind === "ready"
        ? runs.data.runs.find((r) => r.id === runId)
        : undefined;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar
          crumbs={[
            { label: "Evals", href: EVALS_PATH_PREFIX },
            { label: summary?.evalName ?? "Run" },
          ]}
          subtitle={
            summary !== undefined ? formatWhen(summary.startedAt) : null
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PageShell width="full" className="page-fill">
            {runDetail.kind === "unauthenticated" ? <SignedOutNotice /> : null}
            {runDetail.kind === "loading" ? (
              <Skeleton className="h-64 w-full" />
            ) : null}
            {runDetail.kind === "error" ? (
              <RichEmptyState
                icon={<ListBullets />}
                title="Couldn't load this run"
                description={runDetail.message}
                actions={[{ label: "Retry", onClick: runDetail.retry }]}
              />
            ) : null}
            {runDetail.kind === "ready" ? (
              <EvalRunDetailView run={runDetail.data} />
            ) : null}
          </PageShell>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar crumbs={[{ label: "Evals" }]} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageShell width="full" className="page-fill">
          {runs.kind === "unauthenticated" ? <SignedOutNotice /> : null}
          {runs.kind === "error" ? (
            <RichEmptyState
              icon={<ListBullets />}
              title="Couldn't load eval runs"
              description={runs.message}
              actions={[{ label: "Retry", onClick: runs.retry }]}
            />
          ) : null}
          {runs.kind === "loading" || runs.kind === "ready" ? (
            <EvalsList
              runs={runs.kind === "ready" ? runs.data.runs : []}
              loading={runs.kind === "loading"}
              onOpenRun={(id) =>
                navigate(`${EVALS_PATH_PREFIX}/${encodeURIComponent(id)}`)
              }
            />
          ) : null}
        </PageShell>
      </div>
    </div>
  );
}
