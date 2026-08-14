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
//
// `applyTextDiffToYText` deliberately takes only the desired end state
// (`after`), never a caller-supplied `before` baseline: an earlier
// version took both and trusted that `yText.toString() === before` still
// held at apply time, which a concurrent remote update (applied between
// the textarea's `onChange` firing and this function running) breaks —
// replaying a diff computed against a stale baseline directly onto doc
// content that has since changed corrupts it (the delete/insert
// positions no longer point at what the diff assumed was there). Reading
// `yText.toString()` fresh, right here, and diffing THAT against `after`
// guarantees the delete+insert always lands on the doc's real current
// content, so `yText.toString() === after` holds afterward no matter what
// raced in — the cost is that a race no longer produces the minimal
// "just what the user typed" op, it produces whatever op reconciles the
// live doc to the user's intended end state, which is the honest
// trade-off once "live" can move out from under a caller.
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

/**
 * Reconciles `yText` to read as `after`, by diffing its OWN live content
 * (read fresh, right here — never a value the caller captured earlier)
 * against `after` and replaying the result as a delete+insert. Wrapped in
 * `doc.transact` (when `yText` is attached to a doc) so the delete and
 * insert land as one atomic Yjs update, not two separate ones a co-editor
 * could observe half-applied.
 *
 * Skips both operations entirely when nothing changed, so a no-op
 * re-render (React calling `onChange` with an identical value) never
 * produces an empty Yjs transaction that would still broadcast as a doc
 * update to every co-editor.
 */
export function applyTextDiffToYText(yText: Y.Text, after: string): void {
  const apply = () => {
    const before = yText.toString();
    if (before === after) return;
    const op = diffText(before, after);
    if (op.deleteCount > 0) yText.delete(op.index, op.deleteCount);
    if (op.insertText.length > 0) yText.insert(op.index, op.insertText);
  };
  if (yText.doc !== null) {
    yText.doc.transact(apply);
  } else {
    apply();
  }
}
