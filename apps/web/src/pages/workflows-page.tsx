import {
  Badge,
  Button,
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
import { Workflow } from "lucide-react";

import { RunsSchema, useAPIQuery } from "../api";
import { Link } from "../navigation";
import { countProp } from "../optional-props";
import type { APIQuery, RunsPage, WorkflowRun } from "../api";
import { purposeRuns } from "../purpose-runs";
import { QueryView } from "../query-view";

const STATUS_TONE: Record<WorkflowRun["status"], BadgeTone> = {
  running: "success",
  deployed: "info",
  updating: "info",
  stopped: "neutral",
  error: "danger",
};

export function WorkflowsPage({
  runs,
  now = Date.now(),
}: {
  readonly runs: APIQuery<RunsPage>;
  /** Reference time for the Started column; injectable for deterministic tests. */
  readonly now?: number;
}) {
  return (
    <>
      <TopBar>
        <TopBarTitle
          {...countProp(
            runs.kind === "ready"
              ? purposeRuns(runs.data.data).length
              : undefined,
          )}
          subtitle="Workflows executing across your benches"
        >
          Workflows
        </TopBarTitle>
      </TopBar>
      <PageShell width="full" className="page-fill">
        <QueryView query={runs} label="your workflows">
          {(page) => {
            const rows = purposeRuns(page.data);
            return rows.length === 0 ? (
              <EmptyState
                icon={<Workflow />}
                title="No active workflows"
                description="When a workflow is executing in one of your benches it appears here. Ask an agent in chat to kick one off."
                action={
                  <Button asChild>
                    <Link to="/chat">Go to chat</Link>
                  </Button>
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workflow</TableHead>
                    <TableHead>Bench</TableHead>
                    <TableHead className="wf-col-address">Address</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell title={run.definitionName}>
                        {run.definitionName}
                      </TableCell>
                      <TableCell title={run.tenantName}>
                        {run.tenantName}
                      </TableCell>
                      <TableCell className="wf-col-address" title={run.address}>
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
            );
          }}
        </QueryView>
      </PageShell>
    </>
  );
}

export function WorkflowsRoute() {
  const runs = useAPIQuery("/api/me/workflows/runs", RunsSchema);
  return <WorkflowsPage runs={runs} />;
}
