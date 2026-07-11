import { and, eq, isNull } from "drizzle-orm";
import { agentInstance, principal, tenant } from "@intx/db/schema";
import type { SidecarLookups } from "@intx/hub-sessions";
import { getLogger } from "@intx/log";
import { parseHeaderSection } from "@intx/mime";
import { principalMailbox } from "../db/schema";
import type { HubDb } from "../db";

const logger = getLogger(["hub", "principal-mailbox"]);

export type PersistMailFn = NonNullable<SidecarLookups["persistMail"]>;

const USER_ADDRESS_PREFIX = "usr_";

// The idempotency key for a workflow gate mailbox item: one per (run, signal)
// occurrence, so a re-projected open gate never writes a duplicate inbox item.
export function gateMailMessageKey(runId: string, signalName: string): string {
  return `gate:${runId}:${signalName}`;
}

/**
 * Mark a gate mailbox item read when its gate is resolved. Idempotent: stamps
 * `read_at` only for the keyed item that is still unread, so a re-accepted or
 * already-read gate is a no-op and an unknown key touches nothing.
 */
export async function markGateMailboxItemRead(
  db: HubDb,
  runId: string,
  signalName: string,
): Promise<void> {
  await db
    .update(principalMailbox)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(principalMailbox.messageKey, gateMailMessageKey(runId, signalName)),
        isNull(principalMailbox.readAt),
      ),
    );
}

function splitAddress(
  address: string,
): { local: string; domain: string } | null {
  const at = address.indexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return { local: address.slice(0, at), domain: address.slice(at + 1) };
}

// Cached list headers, parsed once at write. A frame whose header section
// the MIME parser rejects still persists — `raw` stays authoritative and
// the read path re-derives what it can — so the parse failure is the
// expected case this catch handles, not a swallowed fault.
function readCachedHeaders(raw: Uint8Array): {
  subject: string | null;
  from: string | null;
} {
  try {
    const { headers } = parseHeaderSection(raw);
    return {
      subject: headers.get("subject") ?? null,
      from: headers.get("from") ?? null,
    };
  } catch {
    return { subject: null, from: null };
  }
}

/**
 * Wrap the upstream `persistMail` lookup so mail addressed to a human
 * user (`usr_<refId>@<tenant domain>`) lands in the workbench-owned
 * `principal_mailbox` table. Upstream persists the sender's outbound
 * record and inbound rows for agent-instance recipients, but skips human
 * addresses — without this seam a workflow's mail to a user is delivered
 * only as a live SSE and never durably readable.
 *
 * Interim sender authorization also lives at this seam, and it governs
 * ONLY the mailbox insert: only an active agent instance earns a durable
 * user copy, and user recipients are resolved strictly within the
 * sender's tenant (refId + `kind: "user"` + the tenant's domain), so
 * cross-tenant delivery is impossible by construction. Every frame is
 * ALWAYS delegated upstream regardless of that gate, and the two writes
 * are independent: an upstream throw still attempts the mailbox insert
 * before propagating, and a mailbox-insert failure is logged loudly but
 * never rejects a persist upstream already completed.
 */
/**
 * One durable user-mailbox row, announced to the triage hook right after its
 * insert. `memberPrincipalId` is the recipient member; `senderAddress` is the
 * transport sender (an agent-instance address), while `fromAddress` is the
 * frame's From header.
 */
export type UserMailboxRowEvent = {
  rowId: string;
  tenantId: string;
  memberPrincipalId: string;
  recipientAddress: string;
  senderAddress: string;
  subject: string | null;
  fromAddress: string | null;
  raw: Uint8Array;
};

export type PrincipalMailboxHooks = {
  /**
   * Fired once per inserted mailbox row, after the insert commits. Strictly
   * best-effort: a hook failure is logged and never affects mail persistence.
   */
  onUserMailboxRow?: (event: UserMailboxRowEvent) => void;
};

export function createPrincipalMailboxPersist(
  db: HubDb,
  upstream: PersistMailFn,
  hooks?: PrincipalMailboxHooks,
): PersistMailFn {
  function announceRow(event: UserMailboxRowEvent): void {
    if (!hooks?.onUserMailboxRow) return;
    try {
      hooks.onUserMailboxRow(event);
    } catch (err) {
      logger.error("principal_mailbox row hook failed for {rowId}", {
        rowId: event.rowId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  async function writeUserMailboxRows(
    senderAddress: string,
    recipients: string[],
    raw: Uint8Array,
  ): Promise<void> {
    const sender = await db.query.agentInstance.findFirst({
      where: and(
        eq(agentInstance.address, senderAddress),
        isNull(agentInstance.endedAt),
      ),
    });
    if (!sender) {
      logger.error(
        "Skipping user mailbox delivery from unauthorized sender {senderAddress}: not an active agent instance",
        { senderAddress },
      );
      return;
    }

    const candidates = recipients
      .map(splitAddress)
      .filter(
        (parts): parts is NonNullable<typeof parts> =>
          parts !== null && parts.local.startsWith(USER_ADDRESS_PREFIX),
      );
    if (candidates.length === 0) return;

    const senderTenant = await db.query.tenant.findFirst({
      where: eq(tenant.id, sender.tenantId),
    });
    if (!senderTenant) {
      logger.error(
        "No tenant row for sender tenant {tenantId}; skipping user mailbox delivery",
        { tenantId: sender.tenantId },
      );
      return;
    }

    const userRecipients: { principalId: string; address: string }[] = [];
    for (const parts of candidates) {
      const address = `${parts.local}@${parts.domain}`;
      if (parts.domain !== senderTenant.domain) {
        logger.warn(
          "Skipping user recipient {address}: domain does not match tenant {tenantId}",
          { address, tenantId: sender.tenantId },
        );
        continue;
      }
      const member = await db.query.principal.findFirst({
        where: and(
          eq(principal.tenantId, sender.tenantId),
          eq(principal.kind, "user"),
          eq(principal.refId, parts.local),
        ),
      });
      if (!member) {
        logger.warn(
          "Skipping user recipient {address}: no member principal with refId {refId} in tenant {tenantId}",
          { address, refId: parts.local, tenantId: sender.tenantId },
        );
        continue;
      }
      userRecipients.push({ principalId: member.id, address });
    }
    if (userRecipients.length === 0) return;

    const cached = readCachedHeaders(raw);
    const insertedRows = await db
      .insert(principalMailbox)
      .values(
        userRecipients.map((recipient) => ({
          tenantId: sender.tenantId,
          principalId: recipient.principalId,
          address: recipient.address,
          direction: "inbound" as const,
          raw: Buffer.from(raw),
          subject: cached.subject,
          fromAddress: cached.from,
        })),
      )
      .returning({ id: principalMailbox.id });

    // `returning` preserves VALUES order, so row ids line up with recipients.
    for (const [index, recipient] of userRecipients.entries()) {
      const insertedRow = insertedRows[index];
      if (!insertedRow) continue;
      announceRow({
        rowId: insertedRow.id,
        tenantId: sender.tenantId,
        memberPrincipalId: recipient.principalId,
        recipientAddress: recipient.address,
        senderAddress,
        subject: cached.subject,
        fromAddress: cached.from,
        raw,
      });
    }
  }

  async function attemptUserMailboxWrite(
    senderAddress: string,
    recipients: string[],
    raw: Uint8Array,
  ): Promise<void> {
    try {
      await writeUserMailboxRows(senderAddress, recipients, raw);
    } catch (err) {
      logger.error(
        "principal_mailbox write failed for mail from {senderAddress}",
        {
          senderAddress,
          error: err instanceof Error ? err : new Error(String(err)),
        },
      );
    }
  }

  return async ({ senderAddress, recipients, raw }) => {
    let results: Awaited<ReturnType<PersistMailFn>>;
    try {
      results = await upstream({ senderAddress, recipients, raw });
    } catch (upstreamErr) {
      await attemptUserMailboxWrite(senderAddress, recipients, raw);
      throw upstreamErr;
    }
    await attemptUserMailboxWrite(senderAddress, recipients, raw);
    return results;
  };
}
