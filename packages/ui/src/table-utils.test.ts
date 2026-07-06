/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  clampPage,
  pageCount,
  pageSlice,
  sortRows,
  toggleSortDir,
} from "./table-utils";

type Row = { name: string; tokens: number };
const ROWS: Row[] = [
  { name: "Bea", tokens: 30 },
  { name: "Ada", tokens: 30 },
  { name: "Cy", tokens: 10 },
];

describe("sortRows", () => {
  it("sorts numbers ascending and descending", () => {
    const asc = sortRows(ROWS, (r) => r.tokens, "asc");
    expect(asc.map((r) => r.tokens)).toEqual([10, 30, 30]);
    const desc = sortRows(ROWS, (r) => r.tokens, "desc");
    expect(desc[0]!.tokens).toBe(30);
    expect(desc[2]!.tokens).toBe(10);
  });

  it("is stable — equal keys keep input order", () => {
    const desc = sortRows(ROWS, (r) => r.tokens, "desc");
    // Bea and Ada both have 30; Bea came first in the input.
    expect(desc.slice(0, 2).map((r) => r.name)).toEqual(["Bea", "Ada"]);
  });

  it("sorts strings by locale compare", () => {
    expect(sortRows(ROWS, (r) => r.name, "asc").map((r) => r.name)).toEqual([
      "Ada",
      "Bea",
      "Cy",
    ]);
  });

  it("does not mutate the input", () => {
    const copy = [...ROWS];
    sortRows(ROWS, (r) => r.tokens, "asc");
    expect(ROWS).toEqual(copy);
  });
});

describe("pagination helpers", () => {
  it("computes page count with a floor of 1", () => {
    expect(pageCount(0, 10)).toBe(1);
    expect(pageCount(21, 10)).toBe(3);
  });

  it("clamps out-of-range pages", () => {
    expect(clampPage(5, 21, 10)).toBe(2);
    expect(clampPage(-1, 21, 10)).toBe(0);
  });

  it("slices the requested page and clamps overflow", () => {
    const rows = [1, 2, 3, 4, 5];
    expect(pageSlice(rows, 0, 2)).toEqual([1, 2]);
    expect(pageSlice(rows, 2, 2)).toEqual([5]);
    // page 9 clamps to the last page rather than returning nothing
    expect(pageSlice(rows, 9, 2)).toEqual([5]);
  });

  it("returns all rows when pagination is disabled", () => {
    expect(pageSlice([1, 2, 3], 0, 0)).toEqual([1, 2, 3]);
  });
});

describe("toggleSortDir", () => {
  it("flips direction", () => {
    expect(toggleSortDir("asc")).toBe("desc");
    expect(toggleSortDir("desc")).toBe("asc");
  });
});
