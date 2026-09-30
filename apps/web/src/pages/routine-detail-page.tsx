import { PageShell, RichEmptyState, RunNowButton, Skeleton } from "@corbits/react-ui";
import { type } from "arktype";
import { useState } from "react";
import { Clock } from "@/lib/icons";

import { useAPIQuery } from "../api";
import { useGlobalRoutines, useRoutineActions } from "../global-routines";
import type { GlobalRoutineRow } from "../global-routines";
import { useNavigate } from "../navigation";
import { WORKFLOWS_PATH_PREFIX } from "../path-ids";
import { PageLayout } from "../shell/page-layout";
import { StageTopBar } from "../shell/stage-top-bar";
import {
  PauseResumeButton,
  RoutinePill,
  formatWhen,
  routineState,
  useRoutineRuns,
} from "./routine-ui";
import type { RunRow } from "./routine-ui";
import { scheduleSentence } from "./routines-page";

const RunEventSchema = type({ seq: "number", type: "string", body: "Record<string, unknown>" });
const RunEventsSchema = type({ runId: "string", events: RunEventSchema.array() });
type RunEvent = typeof RunEventSchema.infer;

function runEventsPath(tenantId: string, runId: string): string {
  return `/api/tenants/${tenantId}/workflows/runs/${encodeURIComponent(runId)}/events`;
}

function runTone(status: RunRow["status"]): "live" | "failed" | "info" | "idle" {
  if (status === "error") return "failed";
  if (status === "running" || status === "updating") return "info";
  return status === "deployed" ? "live" : "idle";
}

function runLabel(status: RunRow["status"]): string {
  if (status === "error") return "failed";
  return status === "deployed" ? "ok" : status;
}

/** The run's own failure text: the newest error-ish event's message. */
function failureMessage(events: readonly RunEvent[]): string | null {
  for (const event of events.toReversed()) {
    if (!/error|fail/i.test(event.type)) continue;
    const { message, error } = event.body;
    if (typeof message === "string") return message;
    if (typeof error === "string") return error;
    return event.type;
  }
  return null;
}

function RunDetail({
  tenantId,
  run,
  onRetry,
}: {
  readonly tenantId: string;
  readonly run: RunRow;
  readonly onRetry: () => Promise<void>;
}) {
  const eventsQuery = useAPIQuery(runEventsPath(tenantId, run.id), RunEventsSchema);
  if (eventsQuery.kind === "loading") return <Skeleton className="h-16 w-full" />;
  if (eventsQuery.kind === "error") {
    return <RichEmptyState title="Couldn't load events" description={eventsQuery.message} />;
  }
  if (eventsQuery.kind === "unauthenticated") return null;
  const events = eventsQuery.data.events;
  const failure = run.status === "error" ? failureMessage(events) : null;
  return (
    <div className="routine-run-detail">
      {run.status === "error" ? (
        <>
          <p className="routine-error">{failure ?? "The run failed without reporting an error."}</p>
          <div>
            <RunNowButton variant="outline" size="sm" label="Retry" onRun={onRetry} />
          </div>
        </>
      ) : null}
      {events.length === 0 ? (
        <span className="routine-meta">No events committed to this run's log.</span>
      ) : (
        <ul className="routine-events" aria-label={`Events for run ${run.id}`}>
          {events.map((event) => (
            <li key={event.seq}>
              {String(event.seq)} {event.type}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RoutineRunsSection({
  tenantId,
  definitionId,
  onRetry,
}: {
  readonly tenantId: string;
  readonly definitionId: string;
  readonly onRetry: () => Promise<void>;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const runsQuery = useRoutineRuns(tenantId, definitionId, 100);

  return (
    <section className="routine-sec">
      <h2>Recent runs</h2>
      {runsQuery.kind === "loading" ? <Skeleton className="h-24 w-full" /> : null}
      {runsQuery.kind === "error" ? (
        <RichEmptyState title="Couldn't load runs" description={runsQuery.message} />
      ) : null}
      {runsQuery.kind === "ready" && runsQuery.data.data.length === 0 ? (
        <RichEmptyState title="No runs yet" description="This workflow hasn't run yet." />
      ) : null}
      {runsQuery.kind === "ready" && runsQuery.data.data.length > 0 ? (
        <div className="routine-rows">
          {runsQuery.data.data.map((run) => (
            <div key={run.id} className="routine-run">
              <button
                type="button"
                className="routine-run-summary"
                aria-expanded={selectedRunId === run.id}
                onClick={() => setSelectedRunId(selectedRunId === run.id ? null : run.id)}
              >
                <span>{formatWhen(run.createdAt)}</span>
                <span className="routine-meta">
                  {run.endedAt === null || run.endedAt === undefined
                    ? "In progress"
                    : `Ended ${formatWhen(run.endedAt)}`}
                </span>
                <RoutinePill tone={runTone(run.status)}>{runLabel(run.status)}</RoutinePill>
              </button>
              {selectedRunId === run.id ? (
                <RunDetail tenantId={tenantId} run={run} onRetry={onRetry} />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function RoutineNotice({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  const navigate = useNavigate();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "Workflows", href: WORKFLOWS_PATH_PREFIX }, { label: title }]}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageLayout title={title}>
          <RichEmptyState
            icon={<Clock />}
            title="Workflow unavailable"
            description={description}
            actions={[
              { label: "Back to Workflows", onClick: () => navigate(WORKFLOWS_PATH_PREFIX) },
            ]}
          />
        </PageLayout>
      </div>
    </div>
  );
}

export function RoutineDetailPage({
  row,
  onRunNow,
}: {
  readonly row: GlobalRoutineRow;
  readonly onRunNow: () => Promise<void>;
}) {
  const sentence = scheduleSentence(row.definition.schedule);
  const runs = useRoutineRuns(row.tenantId, row.definition.definitionId, 1);
  const lastRun = runs.kind === "ready" ? runs.data.data[0] : undefined;
  const state = routineState(row, lastRun);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[
          { label: "Workflows", href: WORKFLOWS_PATH_PREFIX },
          { label: row.definition.name },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <PauseResumeButton row={row} />
            <RunNowButton variant="outline" size="sm" onRun={onRunNow} />
          </div>
        }
      />
      <PageShell>
        <div className="routines-page">
          <div className="routine-head">
            <h1>{row.definition.name}</h1>
            <RoutinePill tone={state.tone}>{state.label}</RoutinePill>
          </div>
          <dl className="routine-kv">
            <dt>Schedule</dt>
            <dd>{sentence}</dd>
            <dt>Workbench</dt>
            <dd>{row.tenantName}</dd>
            <dt>Last run</dt>
            <dd>{runs.kind === "ready" ? formatWhen(lastRun?.createdAt) : "…"}</dd>
          </dl>
          <RoutineRunsSection
            tenantId={row.tenantId}
            definitionId={row.definition.definitionId}
            onRetry={onRunNow}
          />
        </div>
      </PageShell>
    </div>
  );
}

export function resolveRoutineSegment(
  rows: readonly GlobalRoutineRow[],
  segment: string,
): GlobalRoutineRow | undefined {
  return rows.find((row) => row.definition.definitionId === segment);
}

export function RoutineDetailRoute({ segment }: { readonly segment: string }) {
  const routinesQuery = useGlobalRoutines();
  const actions = useRoutineActions();
  const rows = routinesQuery.kind === "ready" ? routinesQuery.data : [];
  const resolved =
    routinesQuery.kind === "ready" ? resolveRoutineSegment(rows, segment) : undefined;

  if (routinesQuery.kind === "loading") {
    return <RoutineNotice title="Routine" description="Loading…" />;
  }
  if (routinesQuery.kind === "error") {
    return <RoutineNotice title={segment} description={routinesQuery.message} />;
  }
  if (resolved === undefined) {
    return (
      <RoutineNotice title={segment} description="No scheduled workflow matches this address." />
    );
  }

  return <RoutineDetailPage row={resolved} onRunNow={() => actions.runNow(resolved)} />;
}
