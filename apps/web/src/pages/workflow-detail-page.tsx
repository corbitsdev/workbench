// `/workflows/<definitionId>` — a workflow definition's own page. Stock's
// `GET /workflows/definitions` (`workflow-detail-api.ts`) exposes only
// name, description, status (`deployed` | `stopped`), current version,
// and timestamps; runs and their event logs come from the stock
// `GET /workflows/runs?definitionId=` listing and `GET
// /workflows/runs/:runId/events` (`vendor/intx/hub-api/src/routes/runs.ts`).
import {
  Badge,
  EmptyState,
  PageShell,
  RichEmptyState,
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
import { Clock, FlowArrow } from "@/lib/icons";
import { useAPIQuery } from "../api";

import { useBench } from "../bench-context";
import { WORKFLOWS_PATH_PREFIX, workflowDefinitionAssetIdFromPath } from "../path-ids";
import { StageTopBar } from "../shell/stage-top-bar";
import { tenantKeys } from "../query-client";
import { useTenantQuery } from "../routines-api";
import {
  getWorkflowDefinitionDetail,
  workflowNotLaunchableReason,
  type WorkflowDefinitionDetailT,
} from "../workflow-detail-api";

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
function WorkflowRunsSection({
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

const STATUS_LABEL: Readonly<Record<WorkflowDefinitionDetailT["status"], string>> = {
  deployed: "Deployed",
  stopped: "Stopped",
};

const STATUS_TONE: Readonly<Record<WorkflowDefinitionDetailT["status"], BadgeTone>> = {
  deployed: "success",
  stopped: "neutral",
};

/** The header row: display name, status badge, and current version. */
function WorkflowDetailHeader({ detail }: { readonly detail: WorkflowDefinitionDetailT }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Badge tone={STATUS_TONE[detail.status]}>{STATUS_LABEL[detail.status]}</Badge>
        <span className="font-mono text-xs text-[var(--ui-fg-muted)]">
          v{detail.currentVersion}
        </span>
      </div>
      {detail.description !== undefined && detail.description !== null ? (
        <p className="m-0 text-sm text-[var(--ui-fg-muted)]">{detail.description}</p>
      ) : null}
    </section>
  );
}

/** Why this definition can't be launched right now — absent entirely once
 * it is `deployed`, never a strip with nothing true to say. */
export function NotLaunchableStrip({
  status,
}: {
  readonly status: WorkflowDefinitionDetailT["status"];
}) {
  const reason = workflowNotLaunchableReason(status);
  if (reason === null) return null;
  return (
    <div className="rounded-md border border-[var(--ui-border)] bg-[var(--ui-bg-muted)] px-4 py-3 text-sm">
      {reason}
    </div>
  );
}

/** The whole page body, given a resolved detail and the tenant it lives on.
 * The header/status strip render straight off `detail`; runs and their
 * event logs are their own live reads (`WorkflowRunsSection`). */
export function WorkflowDetailPage({
  detail,
  tenantId,
}: {
  readonly detail: WorkflowDefinitionDetailT;
  readonly tenantId: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "Workflows", href: WORKFLOWS_PATH_PREFIX }, { label: detail.name }]}
      />
      <PageShell width="full" className="page-fill">
        <div className="flex flex-col gap-6">
          <WorkflowDetailHeader detail={detail} />
          <NotLaunchableStrip status={detail.status} />
          <WorkflowRunsSection tenantId={tenantId} definitionId={detail.definitionId} />
        </div>
      </PageShell>
    </div>
  );
}

/** A workflow-shaped screen with nothing to show yet. */
function WorkflowNotice({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar crumbs={[{ label: title }]} />
      <PageShell width="full" className="page-fill">
        <EmptyState icon={<FlowArrow />} title={title} description={description} />
      </PageShell>
    </div>
  );
}

export function WorkflowDetailRoute({ path }: { readonly path: string }) {
  const { selectedTenantId } = useBench();
  const definitionAssetId = workflowDefinitionAssetIdFromPath(path);
  const tenantId = selectedTenantId ?? "";
  const enabled = definitionAssetId !== null && selectedTenantId !== null;

  const detailQuery = useTenantQuery(
    [...tenantKeys.definitions(tenantId), "detail", definitionAssetId ?? ""],
    enabled,
    () => getWorkflowDefinitionDetail(tenantId, definitionAssetId ?? ""),
  );

  if (definitionAssetId === null) {
    return (
      <WorkflowNotice
        title="No workflow at this address"
        description="The link points at a workflow this workbench can't read."
      />
    );
  }

  if (detailQuery.kind === "loading" || detailQuery.kind === "unauthenticated") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Workflows", href: WORKFLOWS_PATH_PREFIX }]} />
        <PageShell width="full" className="page-fill">
          <EmptyState icon={<Clock />} title="Loading workflow…" />
        </PageShell>
      </div>
    );
  }

  if (detailQuery.kind === "error") {
    return <WorkflowNotice title="Workflow" description={detailQuery.message} />;
  }

  return <WorkflowDetailPage detail={detailQuery.data} tenantId={tenantId} />;
}
