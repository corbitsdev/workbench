// The "your benches" table: every bench the signed-in account belongs to,
// with its roles there. Bench names come from the server-resolved
// `tenantName` — never the tenant id.

import {
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";

import { membershipDisplay } from "./membership";
import { BENCH_STRINGS } from "./strings";
import type { BenchMembership } from "./api";

export function MembershipsTable({
  memberships,
  activeTenantId = null,
  onSelect,
}: {
  readonly memberships: readonly BenchMembership[];
  readonly activeTenantId?: string | null;
  readonly onSelect?: (tenantId: string) => void;
}) {
  if (memberships.length === 0) {
    return (
      <EmptyState
        title={BENCH_STRINGS.membershipsEmptyTitle}
        description={BENCH_STRINGS.membershipsEmptyDescription}
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Bench</TableHead>
          <TableHead>Roles</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {memberships.map((membership) => {
          const display = membershipDisplay(membership);
          const active = display.tenantId === activeTenantId;
          return (
            <TableRow
              key={display.tenantId}
              aria-current={active ? "true" : undefined}
              className={onSelect ? "bench-row-selectable" : undefined}
              onClick={onSelect ? () => onSelect(display.tenantId) : undefined}
            >
              <TableCell>{display.name}</TableCell>
              <TableCell>{display.roleLabel}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
