// Insights I1 + I2: live rollups, day-bucket timeline, and deep-links into
// Routines for each recent run. No new analytics backend — honest numbers
// from data the page already loads.

import {
  Badge,
  PageShell,
  RichEmptyState,
  Section,
  Skeleton,
  StatGrid,
  StatTile,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import { ChartColumn } from "lucide-react";
import type { ReactNode } from "react";

import { RunsSchema, useAPIQuery } from "../api";
import type { APIQuery, RunsPage, WorkflowRun } from "../api";
import { useBench } from "../bench-context";
import { runDeepLinkTarget } from "../insights-deeplinks";
import { computeInsightsStats } from "../insights-stats";
import {
  bucketRunsByDay,
  INSIGHTS_TIMELINE_DAYS,
  type DayBucket,
} from "../insights-timeline";
import { Link } from "../navigation";
import { tenantKeys } from "../query-client";
import { SignedOutNotice } from "../query-view";
import { listRoutines, useTenantQuery, type Routine } from "../routines-api";

function tileValue(value: number | null, loading: boolean): ReactNode {
  if (loading) return <Skeleton className="stat-skeleton" />;
  if (value === null) return "—";
  return value;
}

function statusTone(
  status: WorkflowRun["status"],
): "success" | "danger" | "neutral" | "info" {
  switch (status) {
    case "running":
    case "updating":
      return "success";
    case "error":
      return "danger";
    case "stopped":
      return "neutral";
    case "deployed":
      return "info";
  }
}

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

function TimelineBars({ buckets }: { readonly buckets: readonly DayBucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div
      className="insights-timeline"
      role="img"
      aria-label={`Purpose runs per day for the last ${buckets.length} days`}
    >
      {buckets.map((bucket) => {
        const heightPct = Math.round((bucket.count / max) * 100);
        return (
          <div
            key={bucket.key}
            className="insights-timeline-bar"
            title={`${bucket.label}: ${bucket.count}`}
          >
            <div
              className="insights-timeline-fill"
              style={{ height: `${heightPct}%` }}
            />
            <span className="insights-timeline-label">{bucket.label}</span>
          </div>
        );
      })}
    </div>
  );
}

export function InsightsPage({
  runs,
  routines,
}: {
  readonly runs: APIQuery<RunsPage>;
  readonly routines: APIQuery<readonly Routine[]>;
}) {
  if (runs.kind === "unauthenticated" || routines.kind === "unauthenticated") {
    return (
      <PageShell width="full" className="page-fill">
        <SignedOutNotice />
      </PageShell>
    );
  }

  const loading = runs.kind === "loading" || routines.kind === "loading";
  const failed =
    runs.kind === "error"
      ? runs.message
      : routines.kind === "error"
        ? routines.message
        : null;

  if (failed !== null && !loading) {
    return (
      <PageShell width="full" className="page-fill">
        <RichEmptyState
          icon={<ChartColumn />}
          title="Couldn't load insights"
          description={failed}
        />
      </PageShell>
    );
  }

  const stats =
    runs.kind === "ready" && routines.kind === "ready"
      ? computeInsightsStats(runs.data.data, routines.data)
      : null;

  const empty =
    stats !== null && stats.totalRuns === 0 && stats.routineCount === 0;

  const timelineBuckets =
    runs.kind === "ready"
      ? bucketRunsByDay(runs.data.data, INSIGHTS_TIMELINE_DAYS)
      : null;

  return (
    <PageShell width="full" className="page-fill">
      <Section
        title="Insights"
        description="Live activity on this bench — workflow runs and routines. Deeper analytics land later."
      >
        <StatGrid>
          <StatTile
            label="Purpose runs"
            value={tileValue(stats?.totalRuns ?? null, loading)}
          />
          <StatTile
            label="Running now"
            value={tileValue(stats?.running ?? null, loading)}
          />
          <StatTile
            label="Errored"
            value={tileValue(stats?.errored ?? null, loading)}
          />
          <StatTile
            label="Routines enabled"
            value={tileValue(
              stats === null ? null : stats.enabledRoutines,
              loading,
            )}
          />
        </StatGrid>
      </Section>

      {timelineBuckets !== null && !empty ? (
        <Section
          title="Last 14 days"
          description="Purpose runs started per UTC day (channel hosts hidden from the underlying list)."
        >
          <TimelineBars buckets={timelineBuckets} />
        </Section>
      ) : null}

      <Section
        title="Routines"
        description={
          stats === null
            ? "Scheduled and on-demand workflows on this bench."
            : `${stats.routineCount} total · ${stats.enabledRoutines} enabled`
        }
      >
        {loading ? (
          <Skeleton className="insights-routines-skeleton" />
        ) : empty ? (
          <RichEmptyState
            icon={<ChartColumn />}
            title="Nothing to chart yet"
            description="Start a purpose workflow or create a routine — Insights will roll them up here."
            actions={[
              {
                label: "Open Routines",
                href: "/routines",
                variant: "primary",
              },
            ]}
          />
        ) : (
          <p className="panel-muted">
            Manage schedules and fire history on{" "}
            <Link to="/routines">Routines</Link>
            {stats !== null && stats.stopped + stats.deployed > 0
              ? ` · ${stats.deployed} deployed · ${stats.stopped} stopped`
              : null}
            .
          </p>
        )}
      </Section>

      {stats !== null && stats.recentRuns.length > 0 ? (
        <Section
          title="Recent runs"
          description="Newest purpose workflow runs first (channel hosts hidden). Click a name to open the run on Routines."
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workflow</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Bench</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.recentRuns.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link to={runDeepLinkTarget(row)}>
                      {row.definitionName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  </TableCell>
                  <TableCell>{row.tenantName}</TableCell>
                  <TableCell>{formatWhen(row.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      ) : null}
    </PageShell>
  );
}

export function InsightsRoute() {
  const { selectedTenantId } = useBench();
  const runs = useAPIQuery("/api/me/workflows/runs", RunsSchema);
  const routines = useTenantQuery(
    selectedTenantId === null
      ? ["tenant", "none", "routines"]
      : tenantKeys.routines(selectedTenantId),
    selectedTenantId !== null,
    () => listRoutines(selectedTenantId as string),
  );

  // No bench selected: still show run rollups (me-scoped); routines empty.
  const routinesForPage: APIQuery<readonly Routine[]> =
    selectedTenantId === null ? { kind: "ready", data: [] } : routines;

  return <InsightsPage runs={runs} routines={routinesForPage} />;
}
