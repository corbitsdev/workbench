import { describe, expect, test } from "bun:test";

import { diffLines, diffTotals, hasChanges } from "./line-diff";

function render(before: string, after: string): string[] {
  return diffLines(before, after).map((line) => {
    const marker =
      line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
    return `${marker}${line.text}`;
  });
}

describe("diffLines", () => {
  test("identical text is all context", () => {
    const lines = diffLines("one\ntwo", "one\ntwo");
    expect(lines.map((line) => line.kind)).toEqual(["context", "context"]);
    expect(hasChanges(lines)).toBe(false);
    expect(diffTotals(lines)).toEqual({ added: 0, removed: 0 });
  });

  test("an edit in the middle leaves the surrounding lines as context", () => {
    expect(render("one\ntwo\nthree", "one\nTWO\nthree")).toEqual([
      " one",
      "-two",
      "+TWO",
      " three",
    ]);
  });

  test("an inserted line is the only change", () => {
    expect(render("one\nthree", "one\ntwo\nthree")).toEqual([
      " one",
      "+two",
      " three",
    ]);
    expect(diffTotals(diffLines("one\nthree", "one\ntwo\nthree"))).toEqual({
      added: 1,
      removed: 0,
    });
  });

  test("a removed line is the only change", () => {
    expect(render("one\ntwo\nthree", "one\nthree")).toEqual([
      " one",
      "-two",
      " three",
    ]);
  });

  test("line numbers point at each side's own revision", () => {
    const lines = diffLines("a\nb", "a\nc\nb");
    expect(
      lines.map((line) => [
        line.kind,
        line.beforeLineNumber,
        line.afterLineNumber,
      ]),
    ).toEqual([
      ["context", 1, 1],
      ["added", null, 2],
      ["context", 2, 3],
    ]);
  });

  test("empty before is all additions and empty after is all removals", () => {
    expect(render("", "one\ntwo")).toEqual(["+one", "+two"]);
    expect(render("one\ntwo", "")).toEqual(["-one", "-two"]);
    expect(diffLines("", "")).toEqual([]);
  });

  test("carriage returns do not read as changed lines", () => {
    expect(hasChanges(diffLines("one\r\ntwo", "one\ntwo"))).toBe(false);
  });

  test("a trailing blank line is a visible addition", () => {
    expect(render("one", "one\n")).toEqual([" one", "+"]);
  });

  test("a rewritten block reads as its removals then its additions", () => {
    expect(render("a\nb\nc\nd", "a\nx\ny\nd")).toEqual([
      " a",
      "-b",
      "-c",
      "+x",
      "+y",
      " d",
    ]);
  });

  test("a moved line is not reported as unchanged in both places", () => {
    const lines = diffLines("header\nbody", "body\nheader");
    expect(diffTotals(lines).added).toBeGreaterThan(0);
    expect(diffTotals(lines).removed).toBeGreaterThan(0);
    expect(
      lines.filter((line) => line.kind === "context").map((line) => line.text),
    ).toHaveLength(1);
  });
});
