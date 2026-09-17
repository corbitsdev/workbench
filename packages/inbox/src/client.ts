// Browser-safe Inbox domain surface: the wire schemas/types a UI parses
// responses with, group classification, the pure bulk-op eligibility rules,
// and the mailbox thread-read fetch client. Re-exported from their owning
// modules rather than redeclared — `./project`, `./group`, and `./bulk`
// import nothing but arktype and (type-only) `@corbits/mailbox`; `./thread-
// client` imports arktype and `@corbits/mailbox`'s own thread schemas
// (a value import, but `@corbits/mailbox` is an external git dependency the
// browser-safe-subpaths check treats as an opaque leaf, not something it
// walks into) — so this subpath adds only `fetch` composition, no server-
// only dependency. The root export (".") also carries `./routes` (hono,
// `@intx/hub-api`), `./delivery` (`@corbits/notify/mailbox`), and
// `./migrations` (`@corbits/mailbox`'s Postgres migration runner) — none of
// which belong in a browser bundle — which is why a UI imports this subpath
// instead of the root. Enforced by `bun run check:browser-safe-subpaths`
// (scripts/checks/browser-safe-subpaths.ts), not just by convention.

export { itemsEligibleForClearDone, itemsEligibleForMarkAllRead } from "./bulk";
export {
  INBOX_GROUPS,
  classificationFromRefs,
  inboxGroupOf,
  isInboxGroup,
  type InboxGroup,
} from "./group";
export {
  InboxCountsSchema,
  InboxItemDetailSchema,
  InboxItemSchema,
  projectInboxItem,
  projectInboxItemDetail,
  type InboxCounts,
  type InboxItem,
  type InboxItemDetail,
} from "./project";
export {
  MailboxThreadFetchError,
  listMailboxThreadsClient,
  readMailboxThreadClient,
  type MailboxThreadListResult,
  type MailboxThreadResult,
} from "./thread-client";
