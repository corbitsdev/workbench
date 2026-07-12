import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import { extractMentions } from "@workbench/shared";
import { writeMailboxMessage } from "./mailbox-write";
import type { HubDb } from "../db";
import type { MailboxEventBus } from "./mailbox-events";

const log = getLogger(["hub", "mention-mail"]);

const { principal, tenant } = intxSchema;

export type DeliverMentionMailArgs = {
  db: HubDb;
  tenantId: string;
  /** The sender's user id (== their principal's refId, the `usr_<id>` token). */
  senderUserId: string;
  senderName: string;
  /** Outbound chat message body, scanned for `@[Name](#usr_<id>)` tokens. */
  content: string;
  /** Link back to the conversation surface, included in the mail body. */
  conversationUrl: string;
  mailboxEventBus?: MailboxEventBus;
};

/**
 * Deliver a "you were mentioned" mail to every tenant member `@`-mentioned in
 * an outbound chat message, via the existing principal_mailbox write path
 * (see `writeMailboxMessage`) — the same durable inbox a workflow gate or
 * mail-triage handoff lands in. Self-mentions are skipped. A mentioned id
 * that does not resolve to a tenant member (stale, cross-tenant, or
 * malformed) is skipped and logged, never surfaced to the sender.
 *
 * Best-effort and non-blocking by contract: every failure is caught and
 * logged here so a mention-mail problem can never fail (or slow down the
 * caller's perception of) the chat send it rides along with.
 */
export async function deliverMentionMail(
  args: DeliverMentionMailArgs,
): Promise<void> {
  const mentions = extractMentions(args.content);
  if (mentions.length === 0) return;

  try {
    const tenantRow = await args.db.query.tenant.findFirst({
      where: eq(tenant.id, args.tenantId),
    });
    if (!tenantRow) {
      log.error("No tenant row for {tenantId}; skipping mention mail", {
        tenantId: args.tenantId,
      });
      return;
    }

    // The tenantId comes from the request URL before interchange's own
    // membership middleware has run, so it is caller-supplied: deliver only
    // when the sender is themselves a member of that tenant.
    const sender = await args.db.query.principal.findFirst({
      where: and(
        eq(principal.tenantId, args.tenantId),
        eq(principal.kind, "user"),
        eq(principal.refId, args.senderUserId),
      ),
    });
    if (!sender) {
      log.warn(
        "Skipping mention mail: sender {senderUserId} is not a member of {tenantId}",
        { senderUserId: args.senderUserId, tenantId: args.tenantId },
      );
      return;
    }

    const snippet =
      args.content.length > 280
        ? `${args.content.slice(0, 280)}…`
        : args.content;

    for (const mention of mentions) {
      if (mention.id === args.senderUserId) continue;

      const member = await args.db.query.principal.findFirst({
        where: and(
          eq(principal.tenantId, args.tenantId),
          eq(principal.kind, "user"),
          eq(principal.refId, mention.id),
        ),
      });
      if (!member) {
        log.warn(
          "Skipping mention mail to {mentionId}: no tenant member with that user id",
          { mentionId: mention.id, tenantId: args.tenantId },
        );
        continue;
      }

      const body = `${args.senderName} mentioned you in a conversation:\n\n${snippet}\n\n${args.conversationUrl}`;
      const contentHash = createHash("sha1")
        .update(args.content)
        .digest("hex")
        .slice(0, 16);

      await writeMailboxMessage(
        args.db,
        {
          tenantId: args.tenantId,
          principalId: member.id,
          address: `${mention.id}@${tenantRow.domain}`,
          fromAddress: `${args.senderUserId}@${tenantRow.domain}`,
          subject: `${args.senderName} mentioned you`,
          body,
          messageKey: `mention:${mention.id}:${contentHash}`,
        },
        args.mailboxEventBus,
      );
    }
  } catch (err) {
    log.error("Mention mail delivery failed", {
      tenantId: args.tenantId,
      senderUserId: args.senderUserId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}
