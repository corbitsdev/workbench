import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { splitMailAddress } from "@workbench/hub-agent";
import { principalMailbox } from "../db/schema";
import type { HubDb } from "../db";
import type { MailboxEventBus } from "./mailbox-events";

const logger = getLogger(["hub", "mailbox-write"]);

export type MailFrameArgs = {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
};

// Header values are single-line by contract; anything that reaches a header
// (an external subject in particular) is flattened so it cannot smuggle in
// extra headers.
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Build a minimal RFC 2822 frame for a hub-authored mailbox row. The mailbox
 * read path treats `raw` as authoritative (headers and snippet are re-derived
 * from it), so a hub-written row must carry a real frame, not just the cached
 * columns.
 */
export function buildMailFrame(args: MailFrameArgs): Uint8Array {
  const from = headerValue(args.from);
  const domain = splitMailAddress(from)?.domain ?? "hub.invalid";
  const headers = [
    `From: ${from}`,
    `To: ${headerValue(args.to)}`,
    `Subject: ${headerValue(args.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
  ];
  if (args.inReplyTo !== undefined) {
    headers.push(`In-Reply-To: ${headerValue(args.inReplyTo)}`);
  }
  const body = args.body.replace(/\r?\n/g, "\r\n");
  return new TextEncoder().encode(`${headers.join("\r\n")}\r\n\r\n${body}\r\n`);
}

export type MailboxWriteArgs = {
  tenantId: string;
  principalId: string;
  /** The recipient's usr_ address the row is filed under. */
  address: string;
  fromAddress: string;
  subject: string;
  body: string;
  /** Idempotency key; a second write with the same key is a no-op. */
  messageKey: string;
  /** Source frame's Message-ID, threading the row to the mail it answers. */
  inReplyTo?: string;
};

/**
 * Write a hub-authored inbound mailbox row directly, bypassing the persistMail
 * seam (so a hub-written row can never re-trigger mail-driven automation).
 * Deduped per (tenant, principal, messageKey); returns null when the key was
 * already written.
 *
 * When `bus` is provided, a successful insert publishes a live delivery signal
 * to the recipient principal — best-effort: a publish failure is logged and
 * never turns a successful mailbox write into a caller-visible error.
 */
export async function writeMailboxMessage(
  db: HubDb,
  args: MailboxWriteArgs,
  bus?: MailboxEventBus,
): Promise<{ id: string } | null> {
  const frameArgs: MailFrameArgs = {
    from: args.fromAddress,
    to: args.address,
    subject: args.subject,
    body: args.body,
  };
  if (args.inReplyTo !== undefined) {
    frameArgs.inReplyTo = args.inReplyTo;
  }
  const raw = buildMailFrame(frameArgs);
  const rows = await db
    .insert(principalMailbox)
    .values({
      tenantId: args.tenantId,
      principalId: args.principalId,
      address: args.address,
      direction: "inbound",
      raw: Buffer.from(raw),
      subject: args.subject,
      fromAddress: args.fromAddress,
      messageKey: args.messageKey,
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
  const row = rows[0];
  if (!row) return null;
  if (bus) {
    try {
      bus.publish(args.principalId, { type: "mailbox", id: row.id });
    } catch (err) {
      logger.error("mailbox event publish failed for {rowId}", {
        rowId: row.id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
  return { id: row.id };
}
