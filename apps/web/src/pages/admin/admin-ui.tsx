import type { ChangeEvent, ReactNode } from "react";
import { useSearchParams } from "react-router";
import { inputFieldClass } from "@workbench/ui";

/**
 * Admin list filter + page state, synced to the URL query string (CL-2807) so
 * the exact page and every filter survive a round-trip to a detail page and
 * back (via breadcrumb, browser Back, refresh, or a shared link). `page` lives
 * under `?page=`; every other filter under its own key. Changing any filter
 * resets to page 1 (a filtered set has a different page count). All writes use
 * `replace` so filtering does not bloat the history stack.
 */
export function useAdminFilters() {
  const [searchParams, setSearchParams] = useSearchParams();

  const get = (key: string): string => searchParams.get(key) ?? "";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const setFilter = (key: string, value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        next.delete("page");
        return next;
      },
      { replace: true },
    );
  };

  const setPage = (n: number) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (n <= 1) next.delete("page");
        else next.set("page", String(n));
        return next;
      },
      { replace: true },
    );
  };

  return { get, page, setFilter, setPage, searchParams };
}

/** The current list URL query string, for a detail page's `?back=` echo. */
export function encodeBackParam(searchParams: URLSearchParams): string {
  const s = searchParams.toString();
  return s ? encodeURIComponent(s) : "";
}

/** Resolve a detail page's `?back=` param into the list path to return to. */
export function backToListPath(basePath: string, back: string | null): string {
  if (!back) return basePath;
  return `${basePath}?${decodeURIComponent(back)}`;
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

/**
 * Loading/empty/error gate for a paginated admin list, where the query resolves
 * to a response envelope (rows + pageInfo) rather than a bare array. The parent
 * extracts `rows`; this renders the three states and only calls `children` once
 * there are rows to show.
 */
export function ListStates({
  isLoading,
  isError,
  rowCount,
  emptyLabel,
  children,
}: {
  isLoading: boolean;
  isError: boolean;
  rowCount: number;
  emptyLabel: string;
  children: ReactNode;
}) {
  if (isLoading) {
    return <p className="p-3 text-sm text-text-2">Loading…</p>;
  }
  if (isError) {
    return (
      <p className="p-3 text-sm text-text-2">
        Could not load this list. Try again in a moment.
      </p>
    );
  }
  if (rowCount === 0) {
    return <p className="p-3 text-sm text-text-2">{emptyLabel}</p>;
  }
  return <>{children}</>;
}

/** Row of filter controls above an admin list. */
export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">{children}</div>
  );
}

/** Debounce-free search input for an admin filter bar. */
export function AdminSearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <input
      type="search"
      value={value}
      placeholder={placeholder}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      className={`${inputFieldClass} max-w-xs`}
    />
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/** Labeled select for an admin filter bar. An empty value is the "all" option. */
export function AdminSelect({
  value,
  onChange,
  options,
  allLabel,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  allLabel: string;
  ariaLabel: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
      className={inputFieldClass}
    >
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
