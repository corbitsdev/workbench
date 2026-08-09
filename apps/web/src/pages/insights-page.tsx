// Insights I1: live rollups from workflow runs + routines already on the hub.
// No new analytics backend — honest numbers, recent runs, and a deep-link into
// Routines for schedule management.

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
import { computeInsightsStats } from "../insights-stats";
import { Link } from "../navigation";
import { tenantKeys } from "../query-client";
import { SignedOutNotice } from "../query-view";
import {
  listRoutines,
  useTenantQuery,
  type Routine,
} from "../routines-api";

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
    stats !== null &&
    stats.totalRuns === 0 &&
    stats.routineCount === 0;

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
              stats === null
                ? null
                : stats.enabledRoutines,
              loading,
            )}
          />
        </StatGrid>
      </Section>

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
          description="Newest purpose workflow runs first (channel hosts hidden)."
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
                  <TableCell>{row.definitionName}</TableCell>
                  <TableCell>
                    <Badge tone={statusTone(row.status)}>
                      {row.status}
                    </Badge>
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
    selectedTenantId === null
      ? { kind: "ready", data: [] }
      : routines;

  return <InsightsPage runs={runs} routines={routinesForPage} />;
}
