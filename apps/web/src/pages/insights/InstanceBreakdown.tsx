import { useState } from "react";
import type { ActivityOverview } from "../../lib/hub-api";
import { sumInferenceTokenClasses } from "./metrics";
import { formatNumber } from "./stats";
import { SectionLabel } from "./section-label";

const INSTANCE_PAGE_SIZE = 10;

export function InstanceBreakdown({
  instances,
}: {
  instances: ActivityOverview["inference"]["byInstance"];
}) {
  const [visibleCount, setVisibleCount] = useState(INSTANCE_PAGE_SIZE);

  if (instances.length === 0) return null;

  const visible = instances.slice(0, visibleCount);
  const remaining = instances.length - visible.length;

  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>By agent instance</SectionLabel>
      <div className="overflow-x-auto rounded-[12px] border border-border">
        <table className="w-full min-w-[560px] text-left text-[13px]">
          <thead className="border-b border-border bg-surface text-[10px] font-semibold uppercase tracking-[0.12em] text-text-3">
            <tr>
              <th className="px-4 py-2 font-medium">Instance</th>
              <th className="px-4 py-2 font-medium">Agent</th>
              <th className="px-4 py-2 text-right font-medium">Turns</th>
              <th className="px-4 py-2 text-right font-medium">Tool calls</th>
              <th className="px-4 py-2 text-right font-medium">Tokens</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-bg">
            {visible.map((row) => (
              <tr key={row.instanceId}>
                <td className="px-4 py-2 font-mono text-[12px] text-text-2">
                  {row.instanceId}
                </td>
                <td className="px-4 py-2 text-text">
                  {row.agentName ?? row.agentId}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-text-2">
                  {formatNumber(row.turnCount)}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-text-2">
                  {formatNumber(row.toolCallCount)}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-text-2">
                  {formatNumber(sumInferenceTokenClasses(row))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {remaining > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-text-3">
            Showing {formatNumber(visible.length)} of{" "}
            {formatNumber(instances.length)}
          </span>
          <button
            type="button"
            onClick={() =>
              setVisibleCount((count) => count + INSTANCE_PAGE_SIZE)
            }
            className="flex min-h-[40px] items-center rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 transition-[color,background-color] duration-150 hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97]"
          >
            Show {Math.min(remaining, INSTANCE_PAGE_SIZE)} more
          </button>
        </div>
      )}
    </div>
  );
}
