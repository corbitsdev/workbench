// Inbox triage surface. The shell registers `/inbox` so parallel page work
// can fill the body without touching routes. Until the mailbox-backed feed
// lands, this is an honest empty state — not a fake list.

import { EmptyState } from "@corbits/react-ui";
import { Inbox } from "lucide-react";

export function InboxRoute() {
  return (
    <div className="page-frame">
      <EmptyState
        icon={<Inbox />}
        title="Inbox"
        description="Approvals and notifications for this bench will land here."
      />
    </div>
  );
}
