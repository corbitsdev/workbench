// A line-level diff over two revisions of the same document, shaped the way
// a review surface renders it: one row per line, in reading order, each row
// knowing whether it was kept, added, or removed and which line number it
// carries on each side.
//
// Three things keep it cheap enough to run in a dialog:
//
//   1. Newlines are normalized first, so a CRLF document never reads as
//      "every line changed" — and callers can write back exactly the text
//      they diffed (`normalizeNewlines` is exported for that).
//   2. The identical head and tail are trimmed before any table is built,
//      so a one-line edit in a 20k-line document costs a linear scan.
//   3. What remains is diffed with a longest-common-subsequence walk, whose
//      table is quadratic — so a hard cap refuses the walk instead of
//      allocating gigabytes, and the caller shows a summary instead.
//
// Long runs of unchanged lines between edits are collapsed into a single
// "skipped" row: a reader needs the neighbourhood of a change, not the
// thousands of lines that did not move.

export type DiffLineKind = "context" | "added" | "removed" | "skipped";

export type DiffLine = {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** Line number in the before revision, or null for an added line. */
  readonly beforeLineNumber: number | null;
  /** Line number in the after revision, or null for a removed line. */
  readonly afterLineNumber: number | null;
  /** How many unchanged lines a `skipped` row stands in for. */
  readonly skippedLines?: number;
};

export type DiffTotals = {
  readonly added: number;
  readonly removed: number;
};

export type DiffLimits = {
  /** Most changed lines, per side, the quadratic walk is allowed. */
  readonly maxLines: number;
  /** Most characters, across both sides, the quadratic walk is allowed. */
  readonly maxCharacters: number;
  /** Unchanged lines kept either side of a change before collapsing. */
  readonly contextLines: number;
};

/** Caps the walk at ~1500×1500 cells (about 9MB of Int32Array) — small
 * enough to stay imperceptible in a dialog, large enough that a realistic
 * document edit is diffed in full. */
export const DEFAULT_DIFF_LIMITS: DiffLimits = {
  maxLines: 1500,
  maxCharacters: 400_000,
  contextLines: 3,
};

export type Diff =
  | { readonly status: "identical" }
  | {
      readonly status: "diffed";
      readonly lines: readonly DiffLine[];
      readonly totals: DiffTotals;
    }
  | {
      readonly status: "too-large";
      readonly beforeLines: number;
      readonly afterLines: number;
      /** Changed lines per side once the identical head and tail are
       * trimmed — the size that actually exceeded the cap. */
      readonly changedBeforeLines: number;
      readonly changedAfterLines: number;
    };

/** One newline convention, so a document saved on Windows or by an editor
 * that emits lone carriage returns diffs — and is written back — as the
 * same bytes the reader reviewed. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function splitLines(text: string): readonly string[] {
  if (text === "") return [];
  return text.split("\n");
}

function characterCount(lines: readonly string[]): number {
  let total = 0;
  for (const line of lines) total += line.length + 1;
  return total;
}

/**
 * Lengths of the longest common subsequence for every suffix pair, so the
 * walk below can always take the branch that keeps more lines in common.
 * One Int32Array per row: the table is the expensive part of a diff, and a
 * typed array keeps it to four bytes a cell.
 */
function commonSuffixLengths(
  before: readonly string[],
  after: readonly string[],
): readonly Int32Array[] {
  const table: Int32Array[] = Array.from(
    { length: before.length + 1 },
    () => new Int32Array(after.length + 1),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const row = table[i];
    const next = table[i + 1];
    if (row === undefined || next === undefined) continue;
    for (let j = after.length - 1; j >= 0; j -= 1) {
      row[j] =
        before[i] === after[j]
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  return table;
}

/** The add/remove/keep script for the changed middle of the document, with
 * line numbers offset by the identical head that was trimmed off. */
function changedRegionScript(
  before: readonly string[],
  after: readonly string[],
  offset: number,
): readonly DiffLine[] {
  const table = commonSuffixLengths(before, after);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const beforeLine = before[i] ?? "";
    const afterLine = after[j] ?? "";
    if (beforeLine === afterLine) {
      out.push({
        kind: "context",
        text: beforeLine,
        beforeLineNumber: offset + i + 1,
        afterLineNumber: offset + j + 1,
      });
      i += 1;
      j += 1;
      continue;
    }
    if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      out.push({
        kind: "removed",
        text: beforeLine,
        beforeLineNumber: offset + i + 1,
        afterLineNumber: null,
      });
      i += 1;
    } else {
      out.push({
        kind: "added",
        text: afterLine,
        beforeLineNumber: null,
        afterLineNumber: offset + j + 1,
      });
      j += 1;
    }
  }
  while (i < before.length) {
    out.push({
      kind: "removed",
      text: before[i] ?? "",
      beforeLineNumber: offset + i + 1,
      afterLineNumber: null,
    });
    i += 1;
  }
  while (j < after.length) {
    out.push({
      kind: "added",
      text: after[j] ?? "",
      beforeLineNumber: null,
      afterLineNumber: offset + j + 1,
    });
    j += 1;
  }
  return out;
}

function contextRun(
  lines: readonly string[],
  beforeStart: number,
  afterStart: number,
): readonly DiffLine[] {
  return lines.map((text, index) => ({
    kind: "context" as const,
    text,
    beforeLineNumber: beforeStart + index + 1,
    afterLineNumber: afterStart + index + 1,
  }));
}

/** Collapses every run of unchanged lines longer than `2 * contextLines`
 * into the lines nearest the changes around it plus one "skipped" row. */
function collapseContext(
  lines: readonly DiffLine[],
  contextLines: number,
): readonly DiffLine[] {
  const out: DiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.kind !== "context") {
      out.push(line);
      index += 1;
      continue;
    }
    let end = index;
    while (lines[end]?.kind === "context") end += 1;
    const run = lines.slice(index, end);
    const atStart = index === 0;
    const atEnd = end === lines.length;
    const head = atStart ? 0 : contextLines;
    const tail = atEnd ? 0 : contextLines;
    if (run.length <= head + tail + 1) {
      out.push(...run);
    } else {
      out.push(...run.slice(0, head));
      const hidden = run.length - head - tail;
      out.push({
        kind: "skipped",
        text: `${String(hidden)} unchanged ${hidden === 1 ? "line" : "lines"}`,
        beforeLineNumber: null,
        afterLineNumber: null,
        skippedLines: hidden,
      });
      out.push(...run.slice(run.length - tail));
    }
    index = end;
  }
  return out;
}

export function diffTotals(lines: readonly DiffLine[]): DiffTotals {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added += 1;
    if (line.kind === "removed") removed += 1;
  }
  return { added, removed };
}

/**
 * The one entry point: a diff of two revisions, or an honest refusal when
 * the changed region is too large to diff inline. Callers render whichever
 * status comes back rather than computing the script a second time.
 */
export function diffText(
  beforeRevision: string,
  afterRevision: string,
  limits: DiffLimits = DEFAULT_DIFF_LIMITS,
): Diff {
  const before = normalizeNewlines(beforeRevision);
  const after = normalizeNewlines(afterRevision);
  if (before === after) return { status: "identical" };

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const changedBefore = beforeLines.slice(prefix, beforeLines.length - suffix);
  const changedAfter = afterLines.slice(prefix, afterLines.length - suffix);

  if (
    changedBefore.length > limits.maxLines ||
    changedAfter.length > limits.maxLines ||
    characterCount(changedBefore) + characterCount(changedAfter) >
      limits.maxCharacters
  ) {
    return {
      status: "too-large",
      beforeLines: beforeLines.length,
      afterLines: afterLines.length,
      changedBeforeLines: changedBefore.length,
      changedAfterLines: changedAfter.length,
    };
  }

  const lines = [
    ...contextRun(beforeLines.slice(0, prefix), 0, 0),
    ...changedRegionScript(changedBefore, changedAfter, prefix),
    ...contextRun(
      beforeLines.slice(beforeLines.length - suffix),
      beforeLines.length - suffix,
      afterLines.length - suffix,
    ),
  ];

  return {
    status: "diffed",
    lines: collapseContext(lines, limits.contextLines),
    totals: diffTotals(lines),
  };
}
