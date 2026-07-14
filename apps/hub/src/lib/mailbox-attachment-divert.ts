import { randomUUID } from "node:crypto";
import { schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import { isAllowedMimeType } from "@intx/types";
import type { MessageAttachment } from "@intx/types/runtime";
import { artifact, artifactVersion } from "../db/schema";
import type { HubDb } from "../db";
import { acceptedMimeTypesForAgentRow } from "../attachment-capability-guard";
import { parseDocument, FileParseError } from "../services/file-parser";

const log = getLogger(["hub", "mailbox-attachment-divert"]);

export type InboundAttachmentDivertResult = {
  /** Attachments the recipient's own model can consume; ride inline unchanged. */
  inlineAttachments: MessageAttachment[];
  /** One rendered `<context>` block per attachment the recipient's model
   * cannot consume natively, carrying its File-Parser-extracted text. */
  contextBlocks: string[];
};

/**
 * Sort inbound mail attachments into what the recipient agent's own model can
 * ride inline vs. what must divert through the File Parser first, mirroring
 * the composer's `attachmentPolicyForAgent` divert (CL-2628 / the
 * fix-myra-image-parser-divert fix) but server-side: mail delivery has no
 * client to divert on its behalf, so the triage dequeue path — the point
 * where the recipient's agent definition is already resolved — does it
 * instead. A diverted attachment is stored as a `kind: "file"` artifact (the
 * same shape the upload route produces) so it has a durable record, then
 * parsed; a parse failure for one attachment degrades to a logged note in its
 * own context block rather than losing the whole triage turn.
 */
export async function divertInboundAttachments(
  db: HubDb,
  args: {
    tenantId: string;
    ownerPrincipalId: string;
    agentRow: typeof intxSchema.agent.$inferSelect;
    attachments: MessageAttachment[];
  },
): Promise<InboundAttachmentDivertResult> {
  if (args.attachments.length === 0) {
    return { inlineAttachments: [], contextBlocks: [] };
  }

  const nativeMimeTypes = acceptedMimeTypesForAgentRow(args.agentRow);
  const inlineAttachments: MessageAttachment[] = [];
  const contextBlocks: string[] = [];

  for (const attachment of args.attachments) {
    if (
      nativeMimeTypes === null ||
      nativeMimeTypes.includes(attachment.contentType)
    ) {
      inlineAttachments.push(attachment);
      continue;
    }

    if (!isAllowedMimeType(attachment.contentType)) {
      log.warn(
        "Inbound mail attachment type is not supported by the File Parser either; dropping from the turn",
        { filename: attachment.name, mimeType: attachment.contentType },
      );
      contextBlocks.push(
        `<context>\nAttachment "${attachment.name}" (${attachment.contentType}) could not be processed and was omitted.\n</context>`,
      );
      continue;
    }

    const artifactId = randomUUID();
    const now = new Date();
    const content = `data:${attachment.contentType};base64,${Buffer.from(
      attachment.data,
    ).toString("base64")}`;
    await db.transaction(async (tx) => {
      await tx.insert(artifact).values({
        id: artifactId,
        tenantId: args.tenantId,
        principalId: args.ownerPrincipalId,
        ownerPrincipalId: args.ownerPrincipalId,
        kind: "file",
        title: attachment.name,
        content,
        source: {
          origin: "imported",
          upload: {
            filename: attachment.name,
            mimeType: attachment.contentType,
          },
        },
        status: "draft",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(artifactVersion).values({
        artifactId,
        version: 1,
        title: attachment.name,
        content,
        authorId: args.ownerPrincipalId,
        createdAt: now,
      });
    });

    try {
      const parsedText = await parseDocument(db, {
        tenantId: args.tenantId,
        traceId: artifactId,
        filename: attachment.name,
        mimeType: attachment.contentType,
        bytes: attachment.data,
      });
      contextBlocks.push(
        `<context>\nAttachment: ${attachment.name}\n\n${parsedText}\n</context>`,
      );
    } catch (err) {
      log.warn(
        "Inbound mail attachment parse failed; noting the failure instead of dropping the turn",
        {
          artifactId,
          filename: attachment.name,
          error: err instanceof FileParseError ? err.message : String(err),
        },
      );
      contextBlocks.push(
        `<context>\nAttachment "${attachment.name}" could not be parsed.\n</context>`,
      );
    }
  }

  return { inlineAttachments, contextBlocks };
}
