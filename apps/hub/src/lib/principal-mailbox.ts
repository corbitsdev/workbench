import { and, eq, isNull, sql } from "drizzle-orm";
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

// Header values are single-line; fold any control characters out so a label or
// address carrying a stray newline can never inject a header or split the frame.
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

// Compose a minimal RFC 2822 frame the existing inbox read path (parseHeaderSection
// + raw body) renders exactly like agent-authored mail.
function buildMailFrame(args: {
  senderAddress: string;
  recipientAddress: string;
  subject: string;
  body: string;
  date: Date;
}): Uint8Array {
  const headers =
    `From: ${sanitizeHeaderValue(args.senderAddress)}\r\n` +
    `To: ${sanitizeHeaderValue(args.recipientAddress)}\r\n` +
    `Subject: ${sanitizeHeaderValue(args.subject)}\r\n` +
    `Date: ${args.date.toUTCString()}\r\n` +
    "\r\n";
  return new TextEncoder().encode(`${headers}${args.body}\r\n`);
}

export type GateMailboxItem = {
  tenantId: string;
  principalId: string;
  recipientAddress: string;
  senderAddress: string;
  subject: string;
  body: string;
  messageKey: string;
  date?: Date;
};

/**
 * Insert a keyed, deduplicated inbound mailbox item. Returns whether a NEW row
 * was written — `false` when the partial unique index on `message_key` absorbed
 * a duplicate. The stored `raw` is a minimal RFC 2822 frame so the inbox read
 * path renders subject/from/body identically to agent-authored mail.
 */
export async function insertGateMailboxItem(
  db: HubDb,
  item: GateMailboxItem,
): Promise<boolean> {
  const raw = buildMailFrame({
    senderAddress: item.senderAddress,
    recipientAddress: item.recipientAddress,
    subject: item.subject,
    body: item.body,
    date: item.date ?? new Date(),
  });
  const inserted = await db
    .insert(principalMailbox)
    .values({
      tenantId: item.tenantId,
      principalId: item.principalId,
      address: item.recipientAddress,
      direction: "inbound" as const,
      raw: Buffer.from(raw),
      subject: item.subject,
      fromAddress: item.senderAddress,
      messageKey: item.messageKey,
    })
    .onConflictDoNothing({
      target: [
        principalMailbox.tenantId,
        principalMailbox.principalId,
        principalMailbox.messageKey,
      ],
      where: sql`${principalMailbox.messageKey} IS NOT NULL`,
    })
    .returning({ id: principalMailbox.id });
  return inserted.length > 0;
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
export function createPrincipalMailboxPersist(
  db: HubDb,
  upstream: PersistMailFn,
): PersistMailFn {
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
    await db.insert(principalMailbox).values(
      userRecipients.map((recipient) => ({
        tenantId: sender.tenantId,
        principalId: recipient.principalId,
        address: recipient.address,
        direction: "inbound" as const,
        raw: Buffer.from(raw),
        subject: cached.subject,
        fromAddress: cached.from,
      })),
    );
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
