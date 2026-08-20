import { describe, expect, test } from "bun:test";

import {
  DEFAULT_DIFF_LIMITS,
  diffText,
  normalizeNewlines,
  type Diff,
  type DiffLine,
} from "./line-diff";

function diffed(before: string, after: string, limits = DEFAULT_DIFF_LIMITS) {
  const diff = diffText(before, after, limits);
  if (diff.status !== "diffed") {
    throw new Error(`expected a diff, got ${diff.status}`);
  }
  return diff;
}

function render(before: string, after: string): string[] {
  return diffed(before, after).lines.map((line: DiffLine) => {
    if (line.kind === "skipped") return `~${line.text}`;
    const marker =
      line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
    return `${marker}${line.text}`;
  });
}

function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${String(i)}`).join(
    "\n",
  );
}

describe("diffText", () => {
  test("identical text is reported as identical, with no script to render", () => {
    const diff: Diff = diffText("one\ntwo", "one\ntwo");
    expect(diff.status).toBe("identical");
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
    expect(diffed("one\nthree", "one\ntwo\nthree").totals).toEqual({
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
    expect(
      diffed("a\nb", "a\nc\nb").lines.map((line) => [
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
    expect(diffText("", "").status).toBe("identical");
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
    const diff = diffed("header\nbody", "body\nheader");
    expect(diff.totals.added).toBeGreaterThan(0);
    expect(diff.totals.removed).toBeGreaterThan(0);
    expect(diff.lines.filter((line) => line.kind === "context")).toHaveLength(
      1,
    );
  });
});

describe("newline conventions", () => {
  test("normalizeNewlines collapses CRLF and lone carriage returns", () => {
    expect(normalizeNewlines("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  test("the same text in two newline conventions is identical, not rewritten", () => {
    expect(diffText("one\r\ntwo", "one\ntwo").status).toBe("identical");
    expect(diffText("one\rtwo", "one\ntwo").status).toBe("identical");
  });
});

describe("long documents", () => {
  test("unchanged runs between edits collapse to a skipped row", () => {
    const before = `head\n${lines(40)}\ntail`;
    const after = `HEAD\n${lines(40)}\nTAIL`;
    const diff = diffed(before, after);
    const skipped = diff.lines.filter((line) => line.kind === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.skippedLines).toBe(34);
    expect(skipped[0]?.text).toBe("34 unchanged lines");
    // Both edits (two rows each), 3 context lines either side of the
    // collapsed run, the skipped row itself, and nothing else.
    expect(diff.lines).toHaveLength(2 + 3 + 1 + 3 + 2);
    expect(diff.totals).toEqual({ added: 2, removed: 2 });
  });

  test("a one-line edit in a 20k-line document diffs on trimmed input, fast", () => {
    const body = lines(20_000);
    const edited = body.replace("line 10000", "line 10000 — revised");
    const started = performance.now();
    const diff = diffed(body, edited);
    const elapsedMs = performance.now() - started;
    expect(diff.totals).toEqual({ added: 1, removed: 1 });
    // The quadratic walk sees one line per side; anything near the full
    // document would blow far past this.
    expect(elapsedMs).toBeLessThan(250);
  });

  test("a wholly rewritten large document is refused instead of allocating for it", () => {
    const before = lines(6_000, "before");
    const after = lines(6_000, "after");
    const diff = diffText(before, after);
    expect(diff).toEqual({
      status: "too-large",
      beforeLines: 6_000,
      afterLines: 6_000,
      changedBeforeLines: 6_000,
      changedAfterLines: 6_000,
    });
  });

  test("the character cap refuses long lines even when the line count is small", () => {
    const before = `${"a".repeat(300_000)}\nx`;
    const after = `${"b".repeat(300_000)}\ny`;
    expect(diffText(before, after).status).toBe("too-large");
  });

  test("the caps are the caller's to set", () => {
    const tiny = { maxLines: 2, maxCharacters: 1_000, contextLines: 1 };
    expect(diffText("a\nb\nc", "x\ny\nz", tiny).status).toBe("too-large");
    expect(diffText("a\nb", "x\ny", tiny).status).toBe("diffed");
  });
});
