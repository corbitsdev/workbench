// The mail-path core shared by every folded-run send/list surface:
// signing and persisting a message into a run's mailbox, and walking
// that mailbox with keyset pagination. Sender identity
// (`fromChannelId`/participant semantics, whose address a message is
// "from") is a caller concern — this module takes the from-address and
// raw content as plain inputs and never synthesizes one from a
// principal id.
import { and, desc, eq, lt, or } from "drizzle-orm";
import { sessionMail } from "@intx/db/schema";
import { parseMailToEmail } from "@intx/mime";
import type { CryptoProvider, MessageAttachment } from "@intx/types/runtime";
import type { FoldedRunsDeps, ListedFoldedMail, SentFoldedMail } from "./types";

const MAIL_PAGE_SIZE = 50;

export type SendFoldedMailParams = {
  tenantId: string;
  sessionId: string;
  /** The address the run being sent to. */
  agentAddress: string;
  /** The honest sender identity — never a run id or principal id synthesized into an address. */
  from: string;
  domain: string;
  content: string;
  attachments?: MessageAttachment[];
  replyTo?: string;
  cryptoProvider: CryptoProvider;
};

/**
 * Signs and persists one message into a folded run's mailbox, and
 * notifies the run's own live subscribers. `sendUserMessage` (the
 * signing/MIME step) and the `session_mail` row share one clock read
 * so the MIME `Date` header and the row's `createdAt` never disagree
 * by however long signing and serialization take.
 */
export async function sendFoldedMail(
  deps: Pick<FoldedRunsDeps, "db" | "sessionService" | "sidecarRouter">,
  params: SendFoldedMailParams,
): Promise<SentFoldedMail> {
  const mailId = crypto.randomUUID();
  const now = new Date();

  const rawMIME = await deps.sessionService.sendUserMessage({
    agentAddress: params.agentAddress,
    from: params.from,
    messageId: `<${mailId}@${params.domain}>`,
    date: now,
    content: params.content,
    ...(params.attachments !== undefined
      ? { attachments: params.attachments }
      : {}),
    ...(params.replyTo !== undefined ? { inReplyTo: params.replyTo } : {}),
    sessionId: params.sessionId,
    tenantId: params.tenantId,
    cryptoProvider: params.cryptoProvider,
  });

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

/** `sendFoldedMailWithRetry`'s default bound: one initial attempt plus two retries. */
export const DEFAULT_SEND_FOLDED_MAIL_ATTEMPTS = 3;

export type SendFoldedMailAttemptResult =
  | { ok: true; mail: SentFoldedMail }
  | { ok: false; error: unknown; attempts: number };

/**
 * `sendFoldedMail`, retried a bounded number of times against a
 * transient failure (a sidecar hiccup, a momentary DB blip), and never
 * throwing — a caller mid-launch (a routine fire, a webhook delivery)
 * has already committed a real run; a first-turn mail that still fails
 * after every retry must not un-launch that run or hide it from
 * correlation. The caller decides what "still failed" means for it
 * (log with the run's own id, surface a delivery-failed marker, ...);
 * this function only bounds the retry and reports the outcome.
 */
export async function sendFoldedMailWithRetry(
  deps: Pick<FoldedRunsDeps, "db" | "sessionService" | "sidecarRouter">,
  params: SendFoldedMailParams,
  maxAttempts: number = DEFAULT_SEND_FOLDED_MAIL_ATTEMPTS,
): Promise<SendFoldedMailAttemptResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const mail = await sendFoldedMail(deps, params);
      return { ok: true, mail };
    } catch (err) {
      lastError = err;
    }
  }
  return { ok: false, error: lastError, attempts: maxAttempts };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
  ).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const parsed = JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf-8"),
  ) as {
    createdAt: string;
    id: string;
  };
  return { createdAt: new Date(parsed.createdAt), id: parsed.id };
}

export type ListFoldedMailParams = {
  tenantId: string;
  sessionId: string;
  cursor?: string;
};

/**
 * Keyset pagination on the same `(createdAt, id)` key the
 * newest-first ordering sorts by: a cursor names the last row the
 * caller has already seen, and this walks strictly older than it —
 * `createdAt < cursor.createdAt`, or a tie broken by `id < cursor.id`
 * — rather than re-fetching the newest page and searching for the
 * cursor inside it, which only ever finds it on page one.
 */
export async function listFoldedMail(
  deps: Pick<FoldedRunsDeps, "db">,
  params: ListFoldedMailParams,
): Promise<ListedFoldedMail> {
  const scope = and(
    eq(sessionMail.tenantId, params.tenantId),
    eq(sessionMail.sessionId, params.sessionId),
  );
  const cursor =
    params.cursor === undefined ? undefined : decodeCursor(params.cursor);
  const where =
    cursor === undefined
      ? scope
      : and(
          scope,
          or(
            lt(sessionMail.createdAt, cursor.createdAt),
            and(
              eq(sessionMail.createdAt, cursor.createdAt),
              lt(sessionMail.id, cursor.id),
            ),
          ),
        );

  const rows = await deps.db
    .select()
    .from(sessionMail)
    .where(where)
    .orderBy(desc(sessionMail.createdAt), desc(sessionMail.id))
    .limit(MAIL_PAGE_SIZE + 1);

  const hasMore = rows.length > MAIL_PAGE_SIZE;
  const page = rows.slice(0, MAIL_PAGE_SIZE);
  const items = page.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    mail: parseMailToEmail(row.raw, row.id),
  }));

  const last = page.length > 0 ? page[page.length - 1] : undefined;
  return {
    items,
    ...(hasMore && last !== undefined
      ? { nextCursor: encodeCursor(last.createdAt, last.id) }
      : {}),
  };
}
