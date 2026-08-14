// Binds a plain `<textarea>` to a `Y.Text` without a rich-text editor
// dependency: a textarea's `input`/`change` event only ever hands back the
// field's whole new value, never the edit itself, so this module
// reconstructs the edit as a single contiguous replace (common prefix +
// common suffix, everything between them changed) and replays it as a
// `Y.Text` delete+insert. That keeps every local edit a small Yjs
// operation instead of "delete everything, insert everything" — which
// would still converge, but would make every keystroke look like a full
// rewrite to every other co-editor and to `artifact-persistence.ts`'s
// stored history.
import type * as Y from "yjs";

export interface TextDiffOp {
  readonly index: number;
  readonly deleteCount: number;
  readonly insertText: string;
}

/** The minimal single-region diff between two strings: the common prefix,
 * the common suffix, and whatever changed in between. Good enough for a
 * textarea's `input` event, which always changes one contiguous run of
 * text (typing, pasting, cutting, deleting) — never a scattered
 * multi-region edit in one event. */
export function diffText(before: string, after: string): TextDiffOp {
  const maxPrefix = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1;

  const maxSuffix = Math.min(before.length, after.length) - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    index: prefix,
    deleteCount: before.length - prefix - suffix,
    insertText: after.slice(prefix, after.length - suffix),
  };
}

/** Replays `diffText(before, after)` onto `yText` as a delete+insert.
 * Skips both operations entirely when nothing changed, so a no-op
 * re-render (React calling `onChange` with an identical value) never
 * produces an empty Yjs transaction that would still broadcast as a doc
 * update to every co-editor. */
export function applyTextDiffToYText(
  yText: Y.Text,
  before: string,
  after: string,
): void {
  const op = diffText(before, after);
  if (op.deleteCount === 0 && op.insertText === "") return;
  if (op.deleteCount > 0) yText.delete(op.index, op.deleteCount);
  if (op.insertText.length > 0) yText.insert(op.index, op.insertText);
}
