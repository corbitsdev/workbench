// Wires `@corbits/mailbox`'s `createMailboxPersist` onto the hub's own
// `persistMail` lookup (`vendor/intx/hub-sessions/src/hub-session-lookups.ts`)
// so every outbound agent frame also lands a durable `principal_mail` row in
// each addressed human participant's mailbox, not just `session_mail`.
//
// Two small seams live here, both host-owned by the package's own contract
// (`persist.ts` in `@corbits/mailbox`): `authorizeSender` decides which
// sender addresses may write at all, and `resolveRefs` stamps a workbench
// ref onto every row of the frame INSIDE the same transaction the package
// already opens, so a bus subscriber sees the ref at event time -- no
// out-of-band UPDATE, no polling read.

import { eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { tenant as tenantTable } from "@intx/db/schema";
import type {
  AuthorizeMailboxSender,
  CreateMailboxPersistOpts,
  MailboxRef,
} from "@corbits/mailbox";
import { resolveRoutableAddress } from "@intx/hub-sessions";
import {
  resolveWorkbenchIdForAgentFrame,
  type ChatStore,
  type RoomMessageStore,
} from "@corbits/chat";

/**
 * `@corbits/mailbox` does not export `ResolveMailboxRefs` itself (only the
 * `CreateMailboxPersistOpts` shape it hangs off), so this derives the same
 * type from the one place it is public rather than re-declaring its shape
 * by hand and drifting from the package's own definition.
 */
type ResolveMailboxRefs = NonNullable<
  CreateMailboxPersistOpts<unknown>["resolveRefs"]
>;

/**
 * Resolve a `mail.outbound` frame's sender run address to the mailbox
 * authorization the package needs: the tenant the resulting rows belong to,
 * and the mail domain that scopes which recipients are even addressable.
 *
 * Mirrors exactly what `persistMail` itself already does to resolve a sender
 * (`resolveRoutableAddress`, the same routable-address resolver) rather than
 * re-deriving liveness some other way: a sender that is not a live run
 * resolves to `undefined` there and to `null` here, which skips the mailbox
 * write while the frame still goes upstream unchanged.
 *
 * This is a genuine double resolve of the same address across one frame --
 * `baseLookups.persistMail` (vendor-owned, `hub-session-lookups.ts`) resolves
 * `senderAddress` for its own `session_mail` write, and this seam resolves it
 * again for mailbox authorization. `createMailboxPersist` calls `upstream`
 * and `authorizeSender` as two independent stages and hands neither's result
 * to the other, so there is no seam to thread one resolution through without
 * changing the vendor-owned `persistMail` signature itself, which the
 * ground rules rule out. Accepted as the cost of two owners agreeing on one
 * fact from two directions: one extra indexed lookup by address per frame,
 * not per recipient.
 */
export function createHubMailboxAuthorizeSender(
  db: DB["db"],
): AuthorizeMailboxSender {
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

/**
 * Build the `resolveRefs` seam: stamps
 * `refs: [{ kind: "workbench", id: workbenchId }]` onto every recipient row
 * of one frame.
 *
 * `workbenchId` is NOT `senderAuthorization.tenantId`. An agent run is
 * launched in its parent BENCH tenant -- that tenant is what
 * `authorizeSender` resolves, and it is also what the resulting
 * `principal_mail` rows themselves are scoped under (same tenant the
 * addressed human principals belong to). The workbench the run is a
 * participant of is a separate id `@corbits/chat` tracks inside that same
 * bench tenant, on `workbench_settings.workbenchId` -- one bench tenant
 * hosts many workbenches. Stamping the bench's tenant id here instead would
 * point every row at an id no workbench thread read can ever resolve.
 *
 * Header-first (CL-7449): an agent that participates in several
 * workbenches at once has no single "the" workbench a bare participant
 * scan can name honestly, so `@corbits/chat`'s
 * `resolveWorkbenchIdForAgentFrame` reads the frame's own `In-Reply-To` /
 * `References` and maps that Message-ID back to the timeline row it
 * answers -- that row's `workbenchId` is authoritative. Only when the
 * frame carries no such header does it fall back to the participant scan,
 * and only takes that scan's answer when it is unambiguous (exactly one
 * workbench); this seam is a thin adapter handing that helper the two
 * stores it needs (`chatStore`, `roomMessages`) plus the frame's own
 * decoded headers.
 */
export function createHubMailboxResolveRefs(
  chatStore: ChatStore,
  roomMessages: Pick<RoomMessageStore, "findByMailMessageId">,
): ResolveMailboxRefs {
  return async ({ senderAddress, senderAuthorization, decoded }) => {
    const inReplyTo = decoded?.headers.get("in-reply-to") ?? undefined;
    const references = decoded?.references;
    const workbenchId = await resolveWorkbenchIdForAgentFrame(
      { chatStore, roomMessages },
      senderAuthorization.tenantId,
      {
        senderAddress,
        ...(inReplyTo !== undefined ? { inReplyTo } : {}),
        ...(references !== undefined ? { references } : {}),
      },
    );
    if (workbenchId === undefined) return undefined;
    const ref: MailboxRef = { kind: "workbench", id: workbenchId };
    return [ref];
  };
}
