import { RichEmptyState, RunNowButton, Skeleton } from "@corbits/react-ui";
import { type } from "arktype";
import { useState } from "react";
import { Clock } from "@/lib/icons";

import { useAPIQuery } from "../api";
import { useGlobalRoutines, useRoutineActions } from "../global-routines";
import type { GlobalRoutineRow } from "../global-routines";
import { useNavigate } from "../navigation";
import { WORKFLOWS_PATH_PREFIX } from "../path-ids";
import { PageLayout } from "../shell/page-layout";
import { ListCard } from "./library-list";
import { StageTopBar } from "../shell/stage-top-bar";
import {
  PauseResumeButton,
  RoutinePill,
  formatWhen,
  routineState,
  useRoutineDescription,
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

const FAILED_WITHOUT_MESSAGE = "The run failed without reporting an error.";

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

/** The Result cell: what the run came to, the failure's own message when it failed. */
function RunResult({ tenantId, run }: { readonly tenantId: string; readonly run: RunRow }) {
  const eventsQuery = useAPIQuery(
    run.status === "error" ? runEventsPath(tenantId, run.id) : "",
    RunEventsSchema,
  );
  if (run.status === "error") {
    const failure =
      eventsQuery.kind === "ready"
        ? (failureMessage(eventsQuery.data.events) ?? FAILED_WITHOUT_MESSAGE)
        : "…";
    return <span title={failure}>{failure}</span>;
  }
  if (run.status === "running" || run.status === "updating") return <span>Running…</span>;
  return <span>{run.status === "deployed" ? "Succeeded" : run.status}</span>;
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
          <p className="routine-error">{failure ?? FAILED_WITHOUT_MESSAGE}</p>
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
        <ListCard
          label="Recent runs"
          columns="minmax(120px, 1fr) minmax(0, 2fr) 100px"
          heads={["When", "Result", "Status"]}
        >
          {runsQuery.data.data.map((run) => (
            <li key={run.id} className="lib-row routine-run">
              <button
                type="button"
                className="lib-cell lib-name routine-run-when"
                aria-expanded={selectedRunId === run.id}
                onClick={() => setSelectedRunId(selectedRunId === run.id ? null : run.id)}
              >
                {formatWhen(run.createdAt)}
              </button>
              <span className="lib-cell lib-cell--soft">
                <RunResult tenantId={tenantId} run={run} />
              </span>
              <span className="lib-cell">
                <RoutinePill tone={runTone(run.status)}>{runLabel(run.status)}</RoutinePill>
              </span>
              {selectedRunId === run.id ? (
                <RunDetail tenantId={tenantId} run={run} onRetry={onRetry} />
              ) : null}
            </li>
          ))}
        </ListCard>
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
  const description = useRoutineDescription(row.tenantId, row.definition.name);
  const paused = state.label === "paused";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[
          { label: "Workflows", href: WORKFLOWS_PATH_PREFIX },
          { label: row.definition.name },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageLayout
          title={row.definition.name}
          subtitle={
            <span className="routine-sub">
              {sentence}
              <RoutinePill tone={state.tone}>{state.label}</RoutinePill>
            </span>
          }
          actions={
            <>
              <PauseResumeButton row={row} />
              <RunNowButton size="sm" onRun={onRunNow} />
            </>
          }
        >
          <dl className="routine-kv">
            <dt>Schedule</dt>
            <dd>{sentence}</dd>
            <dt>Delivers to</dt>
            <dd>{row.tenantName === "" ? "This workbench" : row.tenantName}</dd>
            <dt>Last run</dt>
            <dd>{runs.kind === "ready" ? formatWhen(lastRun?.createdAt) : "…"}</dd>
            <dt>Next run</dt>
            <dd>{paused ? "Paused" : sentence}</dd>
          </dl>
          {description !== null ? (
            <section className="routine-sec">
              <h2>What it does</h2>
              <p className="routine-prose">{description}</p>
            </section>
          ) : null}
          <RoutineRunsSection
            tenantId={row.tenantId}
            definitionId={row.definition.definitionId}
            onRetry={onRunNow}
          />
        </PageLayout>
      </div>
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
