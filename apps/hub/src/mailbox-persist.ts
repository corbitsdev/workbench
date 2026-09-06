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
  MailboxPersistArgs,
  MailboxRef,
} from "@corbits/mailbox";
import { resolveRoutableAddress } from "@intx/hub-sessions";
import {
  resolveWorkbenchIdForAgentFrame,
  type ChatStore,
  type RoomMessageStore,
} from "@corbits/chat";
import { ensureRunSession, type EventCollectorPort } from "@corbits/workflows";
import { reportError } from "@corbits/error-sink";
import { getLogger } from "@intx/log";

const logger = getLogger(["hub", "mailbox-persist"]);

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
/**
 * Wraps the hub's own `persistMail` (vendor's `baseLookups.persistMail`)
 * so a run's `agent_session` and event collector exist before that write
 * runs — CL-7480: the first inbound mail on a freshly triggered run is
 * often the earliest point the run is mail-routable at all, since
 * `workflow_run.principal_id` only reconciles onto the trigger that just
 * fired. Resolves the frame's own sender address to its run
 * (`resolveRoutableAddress`, the same resolver `persistMail` itself
 * uses) rather than assuming the caller already knows it; a sender that
 * is not a live run resolves to `undefined` and this is a no-op past
 * that point. Best-effort: `ensureRunSession` failing must not swallow
 * the mail upstream is about to persist regardless, so this only
 * degrades to "no session yet" rather than ever throwing past itself.
 *
 * `eventCollectorsRef` is a forward reference (the same pattern this
 * file's other composition-order refs use, e.g. `apps/hub/src/index.ts`'s
 * `grantAllowanceGateRef`): the wrapped `eventCollectors` registry isn't
 * constructed until after `lookups` is, so this only reads `.current`
 * inside the returned closure, never at wiring time.
 */
export function createHubPersistMailWithSessionEnsure<R extends readonly unknown[]>(
  db: DB["db"],
  eventCollectorsRef: { current?: Pick<EventCollectorPort, "create" | "has"> },
  upstream: (args: MailboxPersistArgs) => Promise<R>,
): (args: MailboxPersistArgs) => Promise<R> {
  return async (args) => {
    const sender = await resolveRoutableAddress(db, args.senderAddress);
    try {
      const eventCollectors = eventCollectorsRef.current;
      if (sender !== undefined && eventCollectors !== undefined) {
        await ensureRunSession({ db, eventCollectors, runId: sender.id });
      }
    } catch (err) {
      reportError(err, {
        operation: "hub.mailboxPersist.ensureRunSession",
        extra: { senderAddress: args.senderAddress },
      });
    }
    // The vendored `session_mail` ledger (`upstream`, `baseLookups.persistMail`)
    // keys on the sender run's principal, which does not exist until the
    // run's first trigger anchors one — a run's own first outbound mail can
    // reach this wrapper before that happens. `@corbits/mailbox`'s own write
    // (this function's caller, `createMailboxPersist`) is keyed on the run
    // address instead and runs regardless, so it is already the durable
    // record for this frame; skip the vendored delegate rather than let it
    // throw "no session for address" past the caller.
    if (sender !== undefined && sender.sessionId === null) {
      logger.debug(
        "skipping vendored persistMail for run {runId}: no session yet",
        { runId: sender.id, senderAddress: args.senderAddress },
      );
      // No `session_mail` rows were written for this frame: an empty
      // result, not a thrown error, so a caller iterating this like
      // `handleMailPersist` does simply emits no `mail.persisted` events.
      return [] as unknown as R;
    }
    return upstream(args);
  };
}

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
