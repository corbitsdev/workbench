/**
 * Pure sort/pagination helpers backing the `SortableTable` primitive, kept
 * separate so the ordering and page math are unit-tested without the DOM.
 */

export type SortDir = "asc" | "desc";

export function toggleSortDir(dir: SortDir): SortDir {
  return dir === "asc" ? "desc" : "asc";
}

/**
 * Stable sort of `rows` by `getValue`. Numbers compare numerically, everything
 * else by locale-aware string compare. Returns a new array; the input is not
 * mutated.
 */
export function sortRows<T>(
  rows: readonly T[],
  getValue: (row: T) => number | string,
  dir: SortDir,
): T[] {
  const indexed = rows.map((row, index) => ({ row, index }));
  const sign = dir === "asc" ? 1 : -1;
  indexed.sort((a, b) => {
    const av = getValue(a.row);
    const bv = getValue(b.row);
    let cmp: number;
    if (typeof av === "number" && typeof bv === "number") {
      cmp = av - bv;
    } else {
      cmp = String(av).localeCompare(String(bv));
    }
    if (cmp !== 0) return cmp * sign;
    return a.index - b.index;
  });
  return indexed.map((entry) => entry.row);
}

/** Total number of pages for `total` rows at `pageSize` (at least 1). */
export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Clamps a requested page index into `[0, pageCount - 1]`. */
export function clampPage(
  page: number,
  total: number,
  pageSize: number,
): number {
  const max = pageCount(total, pageSize) - 1;
  if (page < 0) return 0;
  return Math.min(page, max);
}

/** The `pageSize`-sized slice of `rows` at the (clamped) `page` index. */
export function pageSlice<T>(
  rows: readonly T[],
  page: number,
  pageSize: number,
): T[] {
  if (pageSize <= 0) return [...rows];
  const clamped = clampPage(page, rows.length, pageSize);
  const start = clamped * pageSize;
  return rows.slice(start, start + pageSize);
}
