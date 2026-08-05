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

import { InstancesSchema, useAPIQuery } from "../api";
import { countProp } from "../optional-props";
import type { APIQuery, Instance, InstancesPage } from "../api";
import { QueryView } from "../query-view";

const STATUS_TONE: Record<Instance["status"], BadgeTone> = {
  running: "success",
  deployed: "info",
  updating: "info",
  stopped: "neutral",
  error: "danger",
};

export function RunsPage({
  instances,
  now = Date.now(),
}: {
  readonly instances: APIQuery<InstancesPage>;
  /** Reference time for the Started column; injectable for deterministic tests. */
  readonly now?: number;
}) {
  return (
    <>
      <TopBar>
        <TopBarTitle
          {...countProp(
            instances.kind === "ready" ? instances.data.data.length : undefined,
          )}
          subtitle="Agent instances running across your workspaces"
        >
          Runs
        </TopBarTitle>
      </TopBar>
      <PageShell className="page-fill">
        <QueryView query={instances} label="your runs">
          {(page) =>
            page.data.length === 0 ? (
              <EmptyState
                icon={<Activity />}
                title="No active runs"
                description="When an agent instance is running in one of your workspaces it appears here."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Address</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.data.map((instance) => (
                    <TableRow key={instance.id}>
                      <TableCell>{instance.agentName}</TableCell>
                      <TableCell>{instance.tenantName}</TableCell>
                      <TableCell>
                        <code>{instance.address}</code>
                      </TableCell>
                      <TableCell>
                        <Badge tone={STATUS_TONE[instance.status]}>
                          {instance.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {formatRelativeTime(instance.createdAt, now)}
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
  const instances = useAPIQuery("/api/me/instances", InstancesSchema);
  return <RunsPage instances={instances} />;
}
