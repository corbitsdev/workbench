import { SortableTable, type SortableColumn } from "@workbench/ui";
import { Link } from "react-router";

import type { UsageByPersonRow } from "../../lib/hub-api";
import { actorHref } from "./ActorActivity";
import { sumInferenceTokenClasses } from "./metrics";
import { formatNumber } from "./stats";

export function SortablePersonTable({
  people,
}: {
  people: UsageByPersonRow[];
}) {
  const columns: SortableColumn<UsageByPersonRow>[] = [
    {
      key: "name",
      header: "Person",
      sortValue: (r) => (r.name ?? "Unknown member").toLowerCase(),
      render: (row) => (
        <span>
          <Link
            to={actorHref(row.principalId)}
            state={{
              id: row.principalId,
              kind: "user",
              displayName: row.name ?? "Unknown member",
              status: "active",
            }}
            className="rounded-[4px] outline-none hover:text-accent hover:underline focus-visible:ring-1 focus-visible:ring-accent"
          >
            {row.name ?? "Unknown member"}
          </Link>
          {row.isSelf && (
            <span className="ml-1.5 text-[11px] font-semibold text-accent">
              (me)
            </span>
          )}
        </span>
      ),
    },
    {
      key: "turnCount",
      header: "Turns",
      align: "right",
      sortValue: (r) => r.turnCount,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.turnCount)}
        </span>
      ),
    },
    {
      key: "toolCallCount",
      header: "Tool calls",
      align: "right",
      sortValue: (r) => r.toolCallCount,
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(r.toolCallCount)}
        </span>
      ),
    },
    {
      key: "tokens",
      header: "Tokens",
      align: "right",
      sortValue: (r) => sumInferenceTokenClasses(r),
      render: (r) => (
        <span className="font-mono tabular-nums">
          {formatNumber(sumInferenceTokenClasses(r))}
        </span>
      ),
    },
  ];
  return (
    <SortableTable
      columns={columns}
      rows={people}
      getRowKey={(r) => r.principalId}
      caption="Usage by person"
      initialSort={{ key: "tokens", dir: "desc" }}
      pageSize={10}
      emptyMessage="No attributed usage for this range"
    />
  );
}
