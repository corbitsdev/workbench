// Wires @corbits/mailbox's createMailboxPersist onto the hub's own
// persistMail lookup so every outbound frame lands a durable
// principal_mail row.

import { eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { tenant as tenantTable } from "@intx/db/schema";
import type { AuthorizeMailboxSender } from "@corbits/mailbox";
import { resolveRoutableAddress } from "@intx/hub-sessions";

export function createHubMailboxAuthorizeSender(db: DB["db"]): AuthorizeMailboxSender {
  return async (senderAddress) => {
    const sender = await resolveRoutableAddress(db, senderAddress);
    if (sender === undefined) return null;
    const [row] = await db
      .select({ domain: tenantTable.domain })
      .from(tenantTable)
      .where(eq(tenantTable.id, sender.tenantId))
      .limit(1);
    if (row === undefined) return null;
    return { tenantId: sender.tenantId, domain: row.domain };
  };
}
