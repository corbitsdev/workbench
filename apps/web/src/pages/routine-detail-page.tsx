// `/workflows/<definitionId>` — a deployed definition's own page: name,
// pause, run now, and its runs (with expandable event logs, from stock's
// `GET /workflows/runs?definitionId=` and `GET
// /workflows/runs/:runId/events` — `vendor/intx/hub-api/src/routes/runs.ts`).
// The id is the definition id.
import {
  Badge,
  Button,
  PageShell,
  RichEmptyState,
  RunNowButton,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import type { BadgeTone } from "@corbits/react-ui";
import { WorkflowRunResponse, paginatedSchema } from "@intx/types";
import { type } from "arktype";
import { useState } from "react";
import type { ReactNode } from "react";

import { useAPIQuery } from "../api";
import { useGlobalRoutines, useRoutineActions } from "../global-routines";
import type { GlobalRoutineRow } from "../global-routines";
import { Link } from "../navigation";
import { WORKFLOWS_PATH_PREFIX } from "../path-ids";
import { StageTopBar } from "../shell/stage-top-bar";

const RunsPageSchema = paginatedSchema(WorkflowRunResponse);
type RunRow = typeof WorkflowRunResponse.infer;

const RunEventSchema = type({ seq: "number", type: "string", body: "Record<string, unknown>" });
const RunEventsSchema = type({ runId: "string", events: RunEventSchema.array() });
type RunEvent = typeof RunEventSchema.infer;

function runsPath(tenantId: string, definitionId: string): string {
  return `/api/tenants/${tenantId}/workflows/runs?definitionId=${encodeURIComponent(definitionId)}&limit=100`;
}

function runEventsPath(tenantId: string, runId: string): string {
  return `/api/tenants/${tenantId}/workflows/runs/${encodeURIComponent(runId)}/events`;
}

const RUN_STATUS_TONE_BY_STATUS: Readonly<Record<RunRow["status"], BadgeTone>> = {
  deployed: "success",
  running: "info",
  updating: "info",
  error: "danger",
  stopped: "neutral",
};

/** A run's event log, fetched on selection. Rendered inline under the runs
 * table rather than a separate route — a definition rarely has enough runs
 * to need one. */
function RunEventsPanel({
  tenantId,
  runId,
}: {
  readonly tenantId: string;
  readonly runId: string;
}) {
  const eventsQuery = useAPIQuery(runEventsPath(tenantId, runId), RunEventsSchema);
  if (eventsQuery.kind === "loading") return <Skeleton className="h-24 w-full" />;
  if (eventsQuery.kind === "error") {
    return <RichEmptyState title="Couldn't load events" description={eventsQuery.message} />;
  }
  if (eventsQuery.kind === "unauthenticated") return null;
  const events: readonly RunEvent[] = eventsQuery.data.events;
  if (events.length === 0) {
    return (
      <RichEmptyState
        title="No events yet"
        description="This run hasn't committed any events to its log."
      />
    );
  }
  return (
    <Table aria-label={`Events for run ${runId}`}>
      <TableHeader>
        <TableRow>
          <TableHead>Seq</TableHead>
          <TableHead>Type</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((event) => (
          <TableRow key={event.seq}>
            <TableCell>{event.seq}</TableCell>
            <TableCell>{event.type}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Runs for this definition, newest first (the listing's own order), with a
 * click-to-expand event log per run. */
function RoutineRunsSection({
  tenantId,
  definitionId,
}: {
  readonly tenantId: string;
  readonly definitionId: string;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const runsQuery = useAPIQuery(runsPath(tenantId, definitionId), RunsPageSchema);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="m-0 text-sm font-semibold">Runs</h2>
      {runsQuery.kind === "loading" ? <Skeleton className="h-24 w-full" /> : null}
      {runsQuery.kind === "error" ? (
        <RichEmptyState title="Couldn't load runs" description={runsQuery.message} />
      ) : null}
      {runsQuery.kind === "ready" && runsQuery.data.data.length === 0 ? (
        <RichEmptyState title="No runs yet" description="This workflow hasn't run yet." />
      ) : null}
      {runsQuery.kind === "ready" && runsQuery.data.data.length > 0 ? (
        <Table aria-label="Runs">
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Ended</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runsQuery.data.data.map((run) => (
              <>
                <TableRow
                  key={run.id}
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer"
                  onClick={() => setSelectedRunId(selectedRunId === run.id ? null : run.id)}
                >
                  <TableCell>
                    <Badge tone={RUN_STATUS_TONE_BY_STATUS[run.status]}>{run.status}</Badge>
                  </TableCell>
                  <TableCell>{run.createdAt}</TableCell>
                  <TableCell>{run.endedAt ?? "—"}</TableCell>
                </TableRow>
                {selectedRunId === run.id ? (
                  <TableRow key={`${run.id}-events`}>
                    <TableCell colSpan={3}>
                      <RunEventsPanel tenantId={tenantId} runId={run.id} />
                    </TableCell>
                  </TableRow>
                ) : null}
              </>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </section>
  );
}

function RoutineNotice({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "Workflows", href: WORKFLOWS_PATH_PREFIX }, { label: title }]}
      />
      <PageShell>
        <p className="m-0 text-sm text-[var(--ui-fg-muted)]">{description}</p>
        {children ?? (
          <p className="mt-4">
            <Link to={WORKFLOWS_PATH_PREFIX}>Back to Workflows</Link>
          </p>
        )}
      </PageShell>
    </div>
  );
}

export function RoutineDetailPage({
  row,
  onToggleEnabled,
  onRunNow,
}: {
  readonly row: GlobalRoutineRow;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onRunNow: () => Promise<void>;
}) {
  const enabled = row.definition.status === "deployed";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[
          { label: "Workflows", href: WORKFLOWS_PATH_PREFIX },
          { label: row.definition.name },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onToggleEnabled(!enabled)}
            >
              {enabled ? "Pause" : "Resume"}
            </Button>
            <RunNowButton variant="outline" size="sm" onRun={onRunNow} />
          </div>
        }
      />
      <PageShell>
        <div className="flex flex-col gap-6">
          <div>
            <h1 className="m-0 text-xl font-semibold">{row.definition.name}</h1>
            <p className="mt-2 text-sm text-[var(--ui-fg-muted)]">{row.tenantName}</p>
          </div>
          <RoutineRunsSection tenantId={row.tenantId} definitionId={row.definition.definitionId} />
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

  return (
    <RoutineDetailPage
      row={resolved}
      onToggleEnabled={(enabled) => {
        void actions.setEnabled(resolved, enabled);
      }}
      onRunNow={() => actions.runNow(resolved)}
    />
  );
}
