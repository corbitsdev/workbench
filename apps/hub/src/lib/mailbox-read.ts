import { and, desc, eq, sql } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { parseHeaderSection } from "@intx/mime";
import type { MailboxMessage, MailboxMessageDetail } from "@workbench/shared";
import { principalMailbox, type PrincipalMailboxRow } from "../db/schema";
import type { HubDb } from "../db";

const logger = getLogger("mailbox-read");

export type MailboxScope = {
  tenantId: string;
  principalId: string;
  limit: number;
};

const SNIPPET_MAX_CHARS = 160;

export type DecodedFrame = {
  headers: Map<string, string>;
  body: string;
};

// A stored frame whose header section the MIME parser rejects is the
// expected case this catch handles: the read path degrades to the cached
// list headers written alongside the raw bytes rather than failing the
// whole inbox for one malformed row.
export function decodeMailFrame(raw: Uint8Array): DecodedFrame | null {
  try {
    const { headers, bodyOffset } = parseHeaderSection(raw);
    const body = new TextDecoder().decode(raw.subarray(bodyOffset)).trim();
    return { headers, body };
  } catch {
    return null;
  }
}

// The UI never parses RFC-2822: an unparseable (or absent) Date header falls
// back to the row's created_at so the wire value is always ISO.
function toISODate(dateHeader: string | undefined, createdAt: Date): string {
  if (dateHeader === undefined) return createdAt.toISOString();
  const parsed = new Date(dateHeader);
  if (Number.isNaN(parsed.getTime())) return createdAt.toISOString();
  return parsed.toISOString();
}

function toMailboxMessage(row: PrincipalMailboxRow): MailboxMessage {
  const decoded = decodeMailFrame(row.raw);
  const headers = decoded?.headers;

  const toHeader = headers?.get("to");
  const to =
    toHeader === undefined
      ? [row.address]
      : toHeader
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0);

  const message: MailboxMessage = {
    id: row.id,
    from: headers?.get("from") ?? row.fromAddress ?? "",
    to,
    date: toISODate(headers?.get("date"), row.createdAt),
    messageId: headers?.get("message-id") ?? row.id,
    read: row.readAt !== null,
  };
  const subject = headers?.get("subject") ?? row.subject ?? undefined;
  if (subject !== undefined) {
    message.subject = subject;
  }
  if (decoded !== null && decoded.body.length > 0) {
    message.snippet = decoded.body.slice(0, SNIPPET_MAX_CHARS);
  }
  return message;
}

/**
 * List the caller's durable mailbox: inbound `principal_mailbox` rows
 * written by the persistMail override, newest first, scoped by the
 * caller's own principal.
 */
export async function listUserMailbox(
  db: HubDb,
  scope: MailboxScope,
): Promise<MailboxMessage[]> {
  const rows = await db.query.principalMailbox.findMany({
    where: and(
      eq(principalMailbox.tenantId, scope.tenantId),
      eq(principalMailbox.principalId, scope.principalId),
      eq(principalMailbox.direction, "inbound"),
    ),
    orderBy: [desc(principalMailbox.createdAt)],
    limit: scope.limit,
  });
  return rows.map(toMailboxMessage);
}

/**
 * Read one mailbox message with its full text body, scoped to the caller's
 * principal so a member can never read another member's mail. Returns null
 * when no row matches the caller's scope. A frame the MIME parser rejects
 * degrades to an empty body (with an error log) — never a 500.
 */
export async function getMailboxMessage(
  db: HubDb,
  args: { tenantId: string; principalId: string; id: string },
): Promise<MailboxMessageDetail | null> {
  const row = await db.query.principalMailbox.findFirst({
    where: and(
      eq(principalMailbox.id, args.id),
      eq(principalMailbox.tenantId, args.tenantId),
      eq(principalMailbox.principalId, args.principalId),
      eq(principalMailbox.direction, "inbound"),
    ),
  });
  if (!row) return null;

  const decoded = decodeFrame(row.raw);
  if (decoded === null) {
    logger.error("stored mailbox frame failed to parse; serving empty body", {
      messageId: row.id,
    });
  }
  return { ...toMailboxMessage(row), body: decoded?.body ?? "" };
}

/**
 * Stamp a mailbox message read, scoped to the caller's principal so a
 * member can never mark (or probe) another member's mail. Idempotent:
 * an already-read message keeps its original read_at. Returns false
 * when no row matches the caller's scope.
 */
export async function markMailboxMessageRead(
  db: HubDb,
  args: { tenantId: string; principalId: string; id: string },
): Promise<boolean> {
  const updated = await db
    .update(principalMailbox)
    .set({ readAt: sql`COALESCE(${principalMailbox.readAt}, now())` })
    .where(
      and(
        eq(principalMailbox.id, args.id),
        eq(principalMailbox.tenantId, args.tenantId),
        eq(principalMailbox.principalId, args.principalId),
      ),
    )
    .returning({ id: principalMailbox.id });
  return updated.length > 0;
}
