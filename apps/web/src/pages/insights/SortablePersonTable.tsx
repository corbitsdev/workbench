import { SortableTable, type SortableColumn } from "@workbench/ui";
import { Link } from "react-router";

import type { UsageByPersonRow } from "../../lib/hub-api";
import { actorHref } from "./ActorActivity";
import { sumInferenceTokenClasses } from "./metrics";
import { formatDollars, formatNumber } from "./stats";

/**
 * The single per-person usage table (CL-3667): turns, tool calls, tokens, and
 * cost together — replacing the three prior renderings of the same per-person
 * data (Top actors by turns chart, Usage by person table, Token spend by actor
 * table). Cost is priced per model per person then summed (CL-2723), never a
 * blended cross-model rate — "partial" flags usage on a model with no
 * models.dev rate.
 */
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
      header: "Chats",
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
    {
      key: "cost",
      header: "Cost",
      align: "right",
      sortValue: (r) => r.cost?.cost.total ?? -1,
      render: (r) => {
        const cost = r.cost;
        // "not priced" covers both a missing catalog (`cost === null`) and the
        // case where every model with usage was unpriced (total stays $0 with
        // `hasUnpriced`) — the latter must never read as a real $0.00 (CL-2723).
        if (cost === null || (cost.hasUnpriced && cost.cost.total === 0)) {
          const title =
            cost === null
              ? "Model pricing was unavailable when this was computed"
              : `No models.dev rate for: ${cost.unpricedModels.join(", ")}`;
          return (
            <span
              title={title}
              className="rounded-[4px] bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-3"
            >
              not priced
            </span>
          );
        }
        return (
          <span className="font-mono tabular-nums text-text">
            {formatDollars(cost.cost.total)}
            {cost.hasUnpriced && (
              <span
                title={`No rate for: ${cost.unpricedModels.join(", ")}`}
                className="ml-1.5 rounded-[4px] bg-surface-2 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-text-3"
              >
                partial
              </span>
            )}
          </span>
        );
      },
    },
  ];
  return (
    <SortableTable
      columns={columns}
      rows={people}
      getRowKey={(r) => r.principalId}
      caption="Usage by person"
      initialSort={{ key: "cost", dir: "desc" }}
      pageSize={10}
      emptyMessage="No attributed usage for this range"
    />
  );
}
