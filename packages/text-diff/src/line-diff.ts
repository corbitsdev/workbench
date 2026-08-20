// A line-level diff over two revisions of the same document. The shape it
// returns is the shape a review surface renders: one row per line, in
// reading order, each row knowing whether it was kept, added, or removed
// and which line number it carries on each side.
//
// The script is the shortest one — a longest-common-subsequence walk — so
// an edit in the middle of a document reads as that one edit rather than
// as "everything from here down changed".

export type DiffLineKind = "context" | "added" | "removed";

export type DiffLine = {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** Line number in the before revision, or null for an added line. */
  readonly beforeLineNumber: number | null;
  /** Line number in the after revision, or null for a removed line. */
  readonly afterLineNumber: number | null;
};

export type DiffTotals = {
  readonly added: number;
  readonly removed: number;
};

function splitLines(text: string): readonly string[] {
  if (text === "") return [];
  return text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * Lengths of the longest common subsequence for every suffix pair, so the
 * walk below can always take the branch that keeps more lines in common.
 */
function commonSuffixLengths(
  before: readonly string[],
  after: readonly string[],
): readonly (readonly number[])[] {
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const row = table[i];
      const next = table[i + 1];
      if (row === undefined || next === undefined) continue;
      row[j] =
        before[i] === after[j]
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  return table;
}

/**
 * The add/remove/keep script that turns `before` into `after`, one line per
 * entry. A trailing newline is a line of its own on the side that has it,
 * which is what makes "added a blank line at the end" visible.
 */
export function diffLines(before: string, after: string): readonly DiffLine[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const table = commonSuffixLengths(beforeLines, afterLines);

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length && j < afterLines.length) {
    const beforeLine = beforeLines[i] ?? "";
    const afterLine = afterLines[j] ?? "";
    if (beforeLine === afterLine) {
      out.push({
        kind: "context",
        text: beforeLine,
        beforeLineNumber: i + 1,
        afterLineNumber: j + 1,
      });
      i += 1;
      j += 1;
      continue;
    }
    const dropBefore = table[i + 1]?.[j] ?? 0;
    const dropAfter = table[i]?.[j + 1] ?? 0;
    if (dropBefore >= dropAfter) {
      out.push({
        kind: "removed",
        text: beforeLine,
        beforeLineNumber: i + 1,
        afterLineNumber: null,
      });
      i += 1;
    } else {
      out.push({
        kind: "added",
        text: afterLine,
        beforeLineNumber: null,
        afterLineNumber: j + 1,
      });
      j += 1;
    }
  }
  while (i < beforeLines.length) {
    out.push({
      kind: "removed",
      text: beforeLines[i] ?? "",
      beforeLineNumber: i + 1,
      afterLineNumber: null,
    });
    i += 1;
  }
  while (j < afterLines.length) {
    out.push({
      kind: "added",
      text: afterLines[j] ?? "",
      beforeLineNumber: null,
      afterLineNumber: j + 1,
    });
    j += 1;
  }
  return out;
}

export function diffTotals(lines: readonly DiffLine[]): DiffTotals {
  return {
    added: lines.filter((line) => line.kind === "added").length,
    removed: lines.filter((line) => line.kind === "removed").length,
  };
}

export function hasChanges(lines: readonly DiffLine[]): boolean {
  return lines.some((line) => line.kind !== "context");
}
