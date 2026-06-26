import type { ReactNode } from "react";

export interface DataTableColumn<T> {
  /** Stable column id, also used as the React key. */
  key: string;
  /** Header label. */
  header: string;
  /** Cell renderer. */
  render: (row: T) => ReactNode;
  /** Optional extra classes for the cell + header (e.g. width, alignment). */
  className?: string;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  /** Row click — when provided, rows become keyboard-activatable buttons. */
  onRowClick?: (row: T) => void;
  /** Accessible label for the table. */
  caption?: string;
}

/**
 * Generic, presentation-only table for the library pages' Rows view. The page
 * supplies typed columns; this owns the shared styling, hover, and keyboard
 * activation so every Rows view reads identically.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  onRowClick,
  caption,
}: DataTableProps<T>) {
  return (
    <table className="w-full border-collapse text-left text-[13px]">
      {caption && <caption className="sr-only">{caption}</caption>}
      <thead>
        <tr className="border-b border-border">
          {columns.map((col) => (
            <th
              key={col.key}
              scope="col"
              className={`px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-3 ${col.className ?? ""}`}
            >
              {col.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const interactive = onRowClick !== undefined;
          return (
            <tr key={getRowKey(row)} className="border-b border-border/60">
              {columns.map((col, colIndex) => (
                <td
                  key={col.key}
                  className={`px-3 py-2.5 align-middle text-text-2 ${col.className ?? ""}`}
                >
                  {interactive && colIndex === 0 ? (
                    <button
                      type="button"
                      onClick={() => onRowClick(row)}
                      className="block w-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      {col.render(row)}
                    </button>
                  ) : (
                    col.render(row)
                  )}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
