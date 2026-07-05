import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";

/**
 * Shared loading/empty/error gate for the admin list surfaces so every browser
 * (definitions, principals, audit) reads identically and none hand-rolls the
 * three states. Renders `children(rows)` only once the query has resolved to a
 * non-empty list.
 */
export function QueryStates<T>({
  query,
  emptyLabel,
  children,
}: {
  query: UseQueryResult<T[]>;
  emptyLabel: string;
  children: (rows: T[]) => ReactNode;
}) {
  if (query.isLoading) {
    return <p className="p-3 text-sm text-text-2">Loading…</p>;
  }
  if (query.isError) {
    return (
      <p className="p-3 text-sm text-text-2">
        Could not load this list. Try again in a moment.
      </p>
    );
  }
  const rows = query.data ?? [];
  if (rows.length === 0) {
    return <p className="p-3 text-sm text-text-2">{emptyLabel}</p>;
  }
  return <>{children(rows)}</>;
}

/** Underline tab-button idiom shared by the admin section nav and the
 * Definitions sub-tabs, so the two surfaces read consistently. */
export function tabButtonClass(active: boolean): string {
  return `rounded-t-sm px-3 py-2 text-sm transition-colors ${
    active
      ? "border-b-2 border-orange font-medium text-text"
      : "border-b-2 border-transparent text-text-2 hover:text-text"
  }`;
}

/** Card frame around a data table. */
export const adminTableCard =
  "overflow-hidden rounded-lg border border-border bg-surface";
