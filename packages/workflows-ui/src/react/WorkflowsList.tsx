import type { ReactNode } from "react";
import { cn } from "./cn";
import { ScopePill, StatusChip } from "./primitives";
import type { WorkflowListItem } from "./types";

const LIST_GRID =
  "grid grid-cols-[minmax(0,1.6fr)_110px_72px_88px_100px] gap-2";

export function WorkflowListHead({
  className,
  columns = ["Workflow", "When", "Scope", "Status", "Next"],
}: {
  className?: string;
  columns?: readonly [string, string, string, string, string];
}) {
  return (
    <div
      className={cn(
        LIST_GRID,
        "sticky top-0 z-[1] shrink-0 border-b border-border bg-surface-2/60 px-3.5 py-2",
        "text-[10.5px] font-bold uppercase tracking-[0.06em] text-text-3",
        className,
      )}
      role="row"
    >
      {columns.map((col) => (
        <span key={col}>{col}</span>
      ))}
    </div>
  );
}

export function WorkflowListSectionHeader({
  title,
  count,
  className,
}: {
  title: string;
  count?: number;
  className?: string;
}) {
  const label =
    count === undefined ? title : `${title} · ${count}`;
  return (
    <div
      className={cn(
        "sticky top-0 z-[1] border-b border-border bg-surface-2/80 px-3.5 py-1.5",
        "text-[11px] font-bold uppercase tracking-[0.05em] text-text-3",
        className,
      )}
      role="rowheader"
    >
      {label}
    </div>
  );
}

export function WorkflowListRow({
  item,
  selected,
  onSelect,
  className,
}: {
  item: WorkflowListItem;
  selected?: boolean;
  onSelect?: (item: WorkflowListItem) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-id={item.id}
      data-kind={item.itemKind}
      aria-selected={selected ?? false}
      onClick={() => onSelect?.(item)}
      className={cn(
        LIST_GRID,
        "h-[46px] w-full items-center border-b border-border px-3.5 text-left transition-colors last:border-b-0",
        "hover:bg-row-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
        selected && "bg-sel",
        item.needsYou && !selected && "bg-accent/[0.04]",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-text">
          {item.title}
        </div>
        {item.subtitle ? (
          <div
            className={cn(
              "truncate text-[11px] text-text-3",
              item.itemKind === "run" && "text-accent-deep/80",
            )}
          >
            {item.subtitle}
          </div>
        ) : null}
      </div>
      <span className="truncate text-[12px] text-text-2">{item.when}</span>
      <ScopePill scope={item.scope} />
      <StatusChip tone={item.statusTone} label={item.statusLabel} />
      <span
        className={cn(
          "truncate font-mono text-[11.5px] text-text-2",
          item.nextSoon && "font-semibold text-accent-deep",
        )}
      >
        {item.nextOrElapsed}
      </span>
    </button>
  );
}

export function WorkflowsList({
  live,
  scheduled,
  selectedId,
  selectedKind,
  onSelect,
  empty,
  className,
  showHead = true,
}: {
  live: readonly WorkflowListItem[];
  scheduled: readonly WorkflowListItem[];
  selectedId?: string | null;
  selectedKind?: "run" | "schedule" | null;
  onSelect?: (item: WorkflowListItem) => void;
  empty?: ReactNode;
  className?: string;
  showHead?: boolean;
}) {
  const hasRows = live.length > 0 || scheduled.length > 0;

  return (
    <div
      className={cn("flex min-h-0 min-w-0 flex-col", className)}
      role="table"
      aria-label="Workflows"
    >
      {showHead ? <WorkflowListHead /> : null}
      <div className="min-h-0 flex-1 overflow-auto" role="rowgroup">
        {!hasRows ? (
          empty ?? (
            <div className="px-4 py-10 text-center text-[13px] text-text-3">
              No workflows match these filters.
            </div>
          )
        ) : (
          <>
            {live.length > 0 ? (
              <>
                <WorkflowListSectionHeader title="Live" count={live.length} />
                {live.map((item) => (
                  <WorkflowListRow
                    key={item.id}
                    item={item}
                    selected={
                      selectedKind === "run" && selectedId === item.id
                    }
                    {...(onSelect ? { onSelect } : {})}
                  />
                ))}
              </>
            ) : null}
            {scheduled.length > 0 ? (
              <>
                <WorkflowListSectionHeader
                  title="Scheduled"
                  count={scheduled.length}
                />
                {scheduled.map((item) => (
                  <WorkflowListRow
                    key={item.id}
                    item={item}
                    selected={
                      selectedKind === "schedule" && selectedId === item.id
                    }
                    {...(onSelect ? { onSelect } : {})}
                  />
                ))}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
