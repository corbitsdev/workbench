// Host vocabulary for `@corbits/mailbox`. The package has none of its own —
// every mount must hand priorities and statuses in. Workbench's three-group
// product layer uses `status` for open/done/snoozed and leaves `priority` as
// a free ranking the write path may set later.

import type { MailboxVocabulary } from "@corbits/mailbox";

export const WORKBENCH_INBOX_PRIORITIES = [
  "urgent",
  "high",
  "normal",
  "low",
] as const;

export const WORKBENCH_INBOX_STATUSES = ["open", "done", "snoozed"] as const;

export type WorkbenchInboxStatus = (typeof WORKBENCH_INBOX_STATUSES)[number];

export const WORKBENCH_MAILBOX_VOCABULARY: MailboxVocabulary = {
  priorities: [...WORKBENCH_INBOX_PRIORITIES],
  statuses: [...WORKBENCH_INBOX_STATUSES],
};
