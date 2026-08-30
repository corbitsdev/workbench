// The bulk product ops (`/counts`, `mark-all-read`, `clear-done`) all walk
// the caller's entire open inbox before acting. `walkAllOpen` is that walk,
// pulled out from `routes.ts` and driven through an injected `listPage` so
// its failure modes — an undecodable cursor, a cursor that never advances,
// an inbox large enough to need an explicit cap — are unit-testable without
// a live Postgres (CL-7207).
//
// Previously this loop treated `decodeMailboxListCursor` returning `null`
// as "done" and silently `break`-ed: a rolling deploy that lands two hub
// versions against `@corbits/mailbox` mid-rollout could change a cursor's
// shape under a long-running walk, and the caller would report success
// having silently stopped partway through the inbox. Throwing instead
// turns that into a loud, reported failure — see routes.ts's callers,
// which report it through `@corbits/error-sink` and answer 500 rather than
// a falsely-complete 200.
import {
  decodeMailboxListCursor,
  type MailboxListCursor,
  type MailboxPage,
} from "@corbits/mailbox";

import { projectInboxItem } from "./project";
import type { InboxItem } from "./project";

// 1000 pages * 100 rows/page = 100k rows — generous for any real inbox,
// tight enough that a cursor bug loops a bounded number of times instead
// of forever.
export const MAX_WALK_PAGES = 1000;

export type ListPageFn = (opts: {
  cursor?: MailboxListCursor;
}) => Promise<MailboxPage>;

/** The walk stopped before covering the whole inbox. `message` says why. */
export class IncompleteWalkError extends Error {}

export async function walkAllOpen(
  listPage: ListPageFn,
  opts: { maxPages?: number } = {},
): Promise<InboxItem[]> {
  const maxPages = opts.maxPages ?? MAX_WALK_PAGES;
  const out: InboxItem[] = [];
  let cursor: MailboxListCursor | undefined;
  let pages = 0;
  for (;;) {
    pages += 1;
    if (pages > maxPages) {
      throw new IncompleteWalkError(
        `inbox walk exceeded ${maxPages} pages without finishing`,
      );
    }
    const page = await listPage(cursor !== undefined ? { cursor } : {});
    for (const message of page.items) out.push(projectInboxItem(message));
    if (page.nextCursor === undefined) break;
    const next = decodeMailboxListCursor(page.nextCursor);
    if (next === null) {
      throw new IncompleteWalkError(
        "inbox walk received an undecodable cursor mid-walk",
      );
    }
    if (
      cursor !== undefined &&
      next.createdAt === cursor.createdAt &&
      next.id === cursor.id
    ) {
      throw new IncompleteWalkError("inbox walk cursor did not advance");
    }
    cursor = next;
  }
  return out;
}
