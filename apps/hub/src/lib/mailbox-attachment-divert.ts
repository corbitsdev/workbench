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

// This path owns its own ceilings, mirroring the upload route
// (`routes/file-parse.ts`): inbound EXTERNAL mail is the least-trusted source
// in the system, and the parse is a synchronous Claude turn running inside the
// serial triage dequeue, so both a size ceiling and a timeout are load-bearing
// (without them one oversized or hung attachment stalls the whole per-tenant
// triage queue).
const MAX_PARSE_FILE_BYTES = 10 * 1024 * 1024; // 10 MB decoded ceiling.
const PARSE_TIMEOUT_MS = 90_000;

class ParseTimeoutError extends Error {
  constructor() {
    super("The attachment took too long to parse.");
    this.name = "ParseTimeoutError";
  }
}

async function withParseTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ParseTimeoutError()), PARSE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
 * instead. Each diverted attachment is parsed FIRST (with a timeout), and only
 * on success is it stored as a `kind: "file"` artifact (the same shape and
 * ordering as the upload route, so a failed parse never leaves an orphan
 * artifact); a parse failure, timeout, or oversize/unsupported attachment
 * degrades to a logged note in its own context block rather than losing the
 * whole triage turn.
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

    if (attachment.data.length > MAX_PARSE_FILE_BYTES) {
      log.warn(
        "Inbound mail attachment exceeds the parse size ceiling; dropping from the turn",
        {
          filename: attachment.name,
          bytes: attachment.data.length,
          maxBytes: MAX_PARSE_FILE_BYTES,
        },
      );
      contextBlocks.push(
        `<context>\nAttachment "${attachment.name}" was too large to process and was omitted.\n</context>`,
      );
      continue;
    }

    // Generate the id up front so the parse's audit trace is keyed to the
    // artifact it will become, but PARSE BEFORE STORING (matching the upload
    // route) so a failed parse never leaves an orphan `kind: "file"` artifact.
    const artifactId = randomUUID();
    let parsedText: string;
    try {
      parsedText = await withParseTimeout(
        parseDocument(db, {
          tenantId: args.tenantId,
          traceId: artifactId,
          filename: attachment.name,
          mimeType: attachment.contentType,
          bytes: attachment.data,
        }),
      );
    } catch (err) {
      const timedOut = err instanceof ParseTimeoutError;
      log.warn(
        "Inbound mail attachment parse failed; noting the failure instead of dropping the turn",
        {
          artifactId,
          filename: attachment.name,
          timedOut,
          error:
            err instanceof FileParseError || err instanceof ParseTimeoutError
              ? err.message
              : String(err),
        },
      );
      const reason = timedOut
        ? "took too long to process"
        : "could not be parsed";
      contextBlocks.push(
        `<context>\nAttachment "${attachment.name}" ${reason} and was omitted.\n</context>`,
      );
      continue;
    }

    // Parse succeeded — persist the durable file artifact (same shape as the
    // upload route), then fold the extracted text into the turn.
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

    contextBlocks.push(
      `<context>\nAttachment: ${attachment.name}\n\n${parsedText}\n</context>`,
    );
  }

  return { inlineAttachments, contextBlocks };
}
