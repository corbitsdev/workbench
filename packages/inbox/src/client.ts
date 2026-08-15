// Browser-safe Inbox domain surface: the wire schemas/types a UI parses
// responses with, group classification, and the pure bulk-op eligibility
// rules. Re-exported from their owning modules rather than redeclared —
// `./project`, `./group`, and `./bulk` already import nothing but arktype
// and (type-only) `@corbits/mailbox`, so this subpath adds no code of its
// own, only a browser-safe cut of the package root. The root export (".")
// also carries `./routes` (hono, `@intx/hub-api`), `./delivery`
// (`@corbits/notify/mailbox`), and `./migrations` (`@corbits/mailbox`'s
// Postgres migration runner) — none of which belong in a browser bundle —
// which is why a UI imports this subpath instead of the root. See
// client.test.ts for the import-surface check.

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
