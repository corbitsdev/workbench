// The current bench's member table: names and roles only, never a raw
// principal id, never a raw ref id.

import {
  Badge,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";

import { memberDisplayName, memberRoleLabel } from "./membership";
import { BENCH_STRINGS } from "./strings";
import type { BenchMember } from "./api";

const STATUS_TONE: Record<
  BenchMember["status"],
  "success" | "info" | "neutral"
> = {
  active: "success",
  invited: "info",
  suspended: "neutral",
  deactivated: "neutral",
};

const STATUS_LABEL: Record<BenchMember["status"], string> = {
  active: BENCH_STRINGS.statusActive,
  invited: BENCH_STRINGS.statusInvited,
  suspended: BENCH_STRINGS.statusSuspended,
  deactivated: BENCH_STRINGS.statusDeactivated,
};

export function MemberList({
  members,
}: {
  readonly members: readonly BenchMember[];
}) {
  if (members.length === 0) {
    return (
      <EmptyState
        title={BENCH_STRINGS.membersEmptyTitle}
        description={BENCH_STRINGS.membersEmptyDescription}
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Roles</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => (
          <TableRow key={member.id}>
            <TableCell>
              {memberDisplayName(member)}
              {member.email !== undefined ? (
                <span className="bench-member-email"> {member.email}</span>
              ) : null}
            </TableCell>
            <TableCell>{memberRoleLabel(member)}</TableCell>
            <TableCell>
              <Badge tone={STATUS_TONE[member.status]}>
                {STATUS_LABEL[member.status]}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
