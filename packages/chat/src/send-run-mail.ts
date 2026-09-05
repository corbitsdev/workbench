// Signs one inbound message via Interchange `sendUserMessage` and
// records it on session_mail so the run's own live subscribers see it.
import { sessionMail } from "@intx/db/schema";
import type { DB } from "@intx/db";
import type { SessionService, SidecarRouter } from "@intx/hub-sessions";
import type { CryptoProvider, MessageAttachment } from "@intx/types/runtime";

export type RunMailDeps = {
  db: DB["db"];
  sessionService: Pick<SessionService, "sendUserMessage">;
  sidecarRouter: Pick<SidecarRouter, "dispatchAgentEvent">;
};

export type SendRunMailParams = {
  tenantId: string;
  sessionId: string;
  agentAddress: string;
  from: string;
  domain: string;
  content: string;
  attachments?: MessageAttachment[];
  replyTo?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: readonly string[];
  cryptoProvider: CryptoProvider;
};

export type SentRunMail = {
  readonly id: string;
  readonly createdAt: string;
};

async function deliverRunMailMIME(
  deps: Pick<RunMailDeps, "sessionService">,
  params: SendRunMailParams,
  mailId: string,
  now: Date,
): Promise<Uint8Array> {
  const userMessageParams = {
    agentAddress: params.agentAddress,
    from: params.from,
    messageId: params.messageId ?? `<${mailId}@${params.domain}>`,
    date: now,
    content: params.content,
    sessionId: params.sessionId,
    tenantId: params.tenantId,
    cryptoProvider: params.cryptoProvider,
  };
  const withAttachments =
    params.attachments !== undefined
      ? { ...userMessageParams, attachments: params.attachments }
      : userMessageParams;
  const inReplyTo = params.inReplyTo ?? params.replyTo;
  const withReplyTo =
    inReplyTo !== undefined
      ? { ...withAttachments, inReplyTo }
      : withAttachments;
  const withReferences =
    params.references !== undefined && params.references.length > 0
      ? { ...withReplyTo, references: [...params.references] }
      : withReplyTo;
  return deps.sessionService.sendUserMessage(withReferences);
}

async function recordRunMail(
  deps: Pick<RunMailDeps, "db" | "sidecarRouter">,
  params: SendRunMailParams,
  mailId: string,
  now: Date,
  rawMIME: Uint8Array,
): Promise<SentRunMail> {
  await deps.db.insert(sessionMail).values({
    id: mailId,
    sessionId: params.sessionId,
    runId: null,
    tenantId: params.tenantId,
    direction: "inbound",
    status: "delivered",
    raw: rawMIME,
    createdAt: now,
  });

  deps.sidecarRouter.dispatchAgentEvent(params.agentAddress, {
    type: "mail.delivered",
    data: {
      id: mailId,
      direction: "inbound",
      receivedAt: now.toISOString(),
    },
  });

  return { id: mailId, createdAt: now.toISOString() };
}

export async function sendRunMail(
  deps: RunMailDeps,
  params: SendRunMailParams,
): Promise<SentRunMail> {
  const mailId = crypto.randomUUID();
  const now = new Date();
  const rawMIME = await deliverRunMailMIME(deps, params, mailId, now);
  return recordRunMail(deps, params, mailId, now, rawMIME);
}
