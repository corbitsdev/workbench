import { type ReactNode, useState } from "react";
import {
  clampPage,
  pageCount,
  pageSlice,
  sortRows,
  toggleSortDir,
  type SortDir,
} from "./table-utils";

export interface SortableColumn<T> {
  /** Stable column id, the React key, and the sort key. */
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /**
   * When present the column is sortable; returns the comparable value for a
   * row. Omit for presentation-only columns (e.g. an actions/link column).
   */
  sortValue?: (row: T) => number | string;
  /** Extra classes applied to both the header and its cells (width/align). */
  className?: string;
  align?: "left" | "right";
}

interface SortableTableProps<T> {
  columns: SortableColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  caption: string;
  /** Column key + direction to sort by initially. */
  initialSort?: { key: string; dir: SortDir };
  /** Rows per page; omit or 0 to disable pagination. */
  pageSize?: number;
  emptyMessage?: string;
}

/**
 * Generic sortable, paginated table primitive. Clicking a sortable header sorts
 * by that column (toggling asc/desc) and marks `aria-sort`; pagination clamps
 * out-of-range pages so a sort that shrinks the row set can never strand the
 * view on an empty page. Presentation-only; callers supply typed columns and
 * put links inside `render` for row-level deep links.
 */
export function SortableTable<T>({
  columns,
  rows,
  getRowKey,
  caption,
  initialSort,
  pageSize = 0,
  emptyMessage = "Nothing to show",
}: SortableTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(
    initialSort?.key ?? null,
  );
  const [sortDir, setSortDir] = useState<SortDir>(initialSort?.dir ?? "desc");
  const [page, setPage] = useState(0);

  const sortColumn = columns.find(
    (col) => col.key === sortKey && col.sortValue,
  );
  const sorted = sortColumn?.sortValue
    ? sortRows(rows, sortColumn.sortValue, sortDir)
    : rows;

  const total = sorted.length;
  const clampedPage = clampPage(page, total, pageSize);
  const visible =
    pageSize > 0 ? pageSlice(sorted, clampedPage, pageSize) : sorted;
  const pages = pageCount(total, pageSize);
  const showPager = pageSize > 0 && pages > 1;

  function onHeaderClick(col: SortableColumn<T>) {
    if (!col.sortValue) return;
    if (col.key === sortKey) {
      setSortDir((dir) => toggleSortDir(dir));
    } else {
      setSortKey(col.key);
      setSortDir("desc");
    }
    setPage(0);
  }

  if (rows.length === 0) {
    return (
      <div
        className="rounded-[12px] border border-border bg-surface px-4 py-6 text-center text-[13px] text-text-3"
        data-testid="sortable-table-empty"
      >
        {emptyMessage}
      </div>
    );
  }

  const rangeStart = pageSize > 0 ? clampedPage * pageSize + 1 : 1;
  const rangeEnd = pageSize > 0 ? rangeStart + visible.length - 1 : total;

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-[12px] border border-border">
        <table
          className="w-full text-left text-[13px]"
          data-testid="sortable-table"
        >
          <caption className="sr-only">{caption}</caption>
          <thead className="border-b border-border bg-surface text-[10px] font-semibold uppercase tracking-[0.12em] text-text-3">
            <tr>
              {columns.map((col) => {
                const active = col.key === sortKey && col.sortValue;
                const ariaSort = active
                  ? sortDir === "asc"
                    ? "ascending"
                    : "descending"
                  : undefined;
                const alignCls = col.align === "right" ? "text-right" : "";
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={ariaSort}
                    className={`px-4 py-2 font-medium ${alignCls} ${col.className ?? ""}`}
                  >
                    {col.sortValue ? (
                      <button
                        type="button"
                        onClick={() => onHeaderClick(col)}
                        data-testid="sortable-header"
                        data-col={col.key}
                        className={`inline-flex items-center gap-1 rounded-[4px] uppercase tracking-[0.12em] outline-none hover:text-text focus-visible:ring-1 focus-visible:ring-accent ${active ? "text-text" : ""}`}
                      >
                        {col.header}
                        {active && (
                          <span aria-hidden data-testid="sort-indicator">
                            {sortDir === "asc" ? "▲" : "▼"}
                          </span>
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-bg">
            {visible.map((row) => (
              <tr key={getRowKey(row)} data-testid="sortable-row">
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-4 py-2 text-text-2 ${col.align === "right" ? "text-right" : ""} ${col.className ?? ""}`}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showPager && (
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-text-3" data-testid="pager-range">
            Showing {rangeStart}–{rangeEnd} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="pager-prev"
              disabled={clampedPage <= 0}
              onClick={() => setPage(clampedPage - 1)}
              className="flex min-h-[32px] items-center rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              Prev
            </button>
            <button
              type="button"
              data-testid="pager-next"
              disabled={clampedPage >= pages - 1}
              onClick={() => setPage(clampedPage + 1)}
              className="flex min-h-[32px] items-center rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
