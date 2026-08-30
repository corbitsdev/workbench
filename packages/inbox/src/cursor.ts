// A decoded pagination cursor is only meaningful against the exact
// view/sort/filter it was minted under — `@corbits/mailbox` embeds all
// three in every cursor it mints precisely so a caller can reject a
// cross-set replay (paging `?group=action`, then reusing that cursor
// under `?group=mention`) instead of silently seeking into the wrong
// result set. `decodeMailboxListCursor` only checks the cursor is
// well-formed; this is the cross-check `@corbits/mailbox`'s own
// `mount.ts` route performs and every other caller must perform itself.
import {
  canonicalMailboxFilter,
  type MailboxFilter,
  type MailboxInboxView,
  type MailboxListCursor,
  type MailboxSort,
} from "@corbits/mailbox";

export type CursorScope = {
  view: MailboxInboxView;
  sort: MailboxSort;
  filter: MailboxFilter;
};

export type CursorMismatch = "view" | "sort" | "filter" | null;

/**
 * Which field of `cursor` disagrees with `expected`, or `null` when the
 * cursor was minted for exactly this scope. Checked in the same order
 * `@corbits/mailbox`'s `mount.ts` checks it, so a caller can reuse its
 * exact error strings (`cursor does not match inbox <field>`).
 */
export function cursorScopeMismatch(
  cursor: MailboxListCursor,
  expected: CursorScope,
): CursorMismatch {
  if (cursor.view !== expected.view) return "view";
  if (cursor.sort !== expected.sort) return "sort";
  if (cursor.filter !== canonicalMailboxFilter(expected.filter)) {
    return "filter";
  }
  return null;
}
