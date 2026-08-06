import {
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
import { ShieldCheck } from "lucide-react";

import { ApprovalsSchema, useAPIQuery } from "../api";
import { countProp } from "../optional-props";
import type { APIQuery, Approval } from "../api";
import { QueryView } from "../query-view";

export function ApprovalsPage({
  approvals,
  now = Date.now(),
}: {
  readonly approvals: APIQuery<Approval[]>;
  /** Reference time for the Requested column; injectable for deterministic tests. */
  readonly now?: number;
}) {
  return (
    <>
      <TopBar>
        <TopBarTitle
          {...countProp(
            approvals.kind === "ready" ? approvals.data.length : undefined,
          )}
          subtitle="Requests waiting on a human decision"
        >
          Approvals
        </TopBarTitle>
      </TopBar>
      <PageShell className="page-fill">
        <QueryView query={approvals} label="approvals">
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState
                icon={<ShieldCheck />}
                title="No approvals waiting"
                description="When a running workflow asks for permission to act, the request lands here with the resource and action it wants. Nothing is waiting on you right now."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Definition</TableHead>
                    <TableHead>Bench</TableHead>
                    <TableHead>Resource</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Requested</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((approval) => (
                    <TableRow key={approval.id}>
                      <TableCell>{approval.definitionName}</TableCell>
                      <TableCell>{approval.tenantName}</TableCell>
                      <TableCell>
                        <code>{approval.resource}</code>
                      </TableCell>
                      <TableCell>
                        <code>{approval.action}</code>
                      </TableCell>
                      <TableCell>
                        {formatRelativeTime(approval.createdAt, now)}
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

export function ApprovalsRoute() {
  const approvals = useAPIQuery("/api/me/approvals", ApprovalsSchema);
  return <ApprovalsPage approvals={approvals} />;
}
