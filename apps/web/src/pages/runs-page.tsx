import {
  Badge,
  EmptyState,
  formatRelativeTime,
  PageShell,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TopBar,
  TopBarTitle,
} from "@corbits/react-ui";
import type { BadgeTone } from "@corbits/react-ui";
import { Activity } from "lucide-react";

import { RunsSchema, useAPIQuery } from "../api";
import { countProp } from "../optional-props";
import type { APIQuery, RunsPage as RunsPageData, WorkflowRun } from "../api";
import { QueryView } from "../query-view";

const STATUS_TONE: Record<WorkflowRun["status"], BadgeTone> = {
  running: "success",
  deployed: "info",
  updating: "info",
  stopped: "neutral",
  error: "danger",
};

export function RunsPage({
  runs,
  now = Date.now(),
}: {
  readonly runs: APIQuery<RunsPageData>;
  /** Reference time for the Started column; injectable for deterministic tests. */
  readonly now?: number;
}) {
  return (
    <>
      <TopBar>
        <TopBarTitle
          {...countProp(
            runs.kind === "ready" ? runs.data.data.length : undefined,
          )}
          subtitle="Workflow runs executing across your benches"
        >
          Runs
        </TopBarTitle>
      </TopBar>
      <PageShell className="page-fill">
        <QueryView query={runs} label="your runs">
          {(page) =>
            page.data.length === 0 ? (
              <EmptyState
                icon={<Activity />}
                title="No active runs"
                description="When a workflow run is executing in one of your benches it appears here."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Definition</TableHead>
                    <TableHead>Bench</TableHead>
                    <TableHead>Address</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.data.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>{run.definitionName}</TableCell>
                      <TableCell>{run.tenantName}</TableCell>
                      <TableCell>
                        <code>{run.address}</code>
                      </TableCell>
                      <TableCell>
                        <Badge tone={STATUS_TONE[run.status]}>
                          {run.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {formatRelativeTime(run.createdAt, now)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          }
        </QueryView>
      </PageShell>
    </>
  );
}

export function RunsRoute() {
  const runs = useAPIQuery("/api/me/workflows/runs", RunsSchema);
  return <RunsPage runs={runs} />;
}
