// Fans a sent workbench message into every human participant's mailbox
// (CL-7450). A person's message already lands durably on the room's own
// timeline (`room-messages.ts`); this is the second, independent copy
// `@corbits/mailbox` keeps per human principal, addressed by the same
// RFC 5322 `Message-ID` the row was stamped with (`./mail-headers.ts`).
//
// Only human participants get a mailbox row — an agent's own inbox is its
// run's live mail queue, dispatched through `WorkbenchMail.sendMail`
// (`./platform-port.ts`), never this package's `@corbits/mailbox` mount.
// `mentions.ts`'s `isAgentAddress` is the same human/agent split the rest
// of this package already uses for fan-out.
//
// The write itself is behind the small `MailboxWriter` port below, not
// called against `@corbits/mailbox` directly: `writeChatMailboxFanout`'s
// own logic (who gets a row, which direction, what the shared Message-ID
// and refs are) is what this ticket is actually about, and it is
// unit-testable with an in-memory writer that never touches Postgres.
// `createDrizzleMailboxWriter` is the one production implementation, and
// is the only piece that needs a live `@corbits/mailbox` schema.
//
// No fallback: a write that fails is reported through `reportError` and
// rethrown — never swallowed into a partially-delivered send that looks
// successful to its caller. A participant address this tenant has no
// principal for is a different, expected case (a stale or removed
// member) and is reported and skipped rather than failing the whole send.
import {
  writeMailboxMessage,
  buildMailFrame,
  generateMailboxMessageId,
  assertMailboxFrameBytes,
  principalMail,
  mailbox,
  type MailboxDb,
  type MailboxEventBus,
  type MailboxRef,
} from "@corbits/mailbox";
import { reportError } from "@corbits/error-sink";
import { isAgentAddress } from "./mentions";
import { domainOf } from "./agent-address";
import type { ParticipantRecord } from "./participants";

export type MailboxWriteArgs = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly address: string;
  readonly fromAddress: string;
  readonly subject: string;
  readonly body: string;
  /** Also the mailbox idempotency key — a retried send with the same
   * key writes nothing twice. */
  readonly messageKey: string;
  readonly inReplyTo?: string;
  readonly refs?: readonly MailboxRef[];
};

/**
 * The write seam `writeChatMailboxFanout` calls through — a durable row
 * in one principal's mailbox, in one direction. Split from
 * `@corbits/mailbox`'s own call surface so this package's fan-out LOGIC
 * (who gets a row, which direction, the shared Message-ID and refs) is
 * unit-testable against an in-memory fake, with only
 * `createDrizzleMailboxWriter` below needing a live database.
 */
export interface MailboxWriter {
  /** A row addressed TO `args.principalId` — every recipient but the
   * sender. Returns null when `messageKey` already wrote a row (retry
   * idempotency), never an error. */
  writeInbound(args: MailboxWriteArgs): Promise<{ id: string } | null>;
  /** The sender's own copy of a message they sent. Returns null on the
   * same retry-idempotency terms as `writeInbound`. */
  writeOutbound(args: MailboxWriteArgs): Promise<{ id: string } | null>;
}

/**
 * The production `MailboxWriter`: inbound rows go through
 * `@corbits/mailbox`'s own `writeMailboxMessage` (which always writes
 * `direction: "inbound"`); outbound rows — the sender's own copy —
 * cannot, since that function has no direction parameter, so they are
 * inserted directly against the package's exported schema tables,
 * mirroring the same eager-management-row shape `writeMailboxMessage`
 * itself writes, with the same best-effort bus publish on insert.
 */
export function createDrizzleMailboxWriter(
  db: MailboxDb,
  bus?: MailboxEventBus,
): MailboxWriter {
  return {
    async writeInbound(args) {
      return writeMailboxMessage(
        db,
        {
          tenantId: args.tenantId,
          principalId: args.principalId,
          address: args.address,
          fromAddress: args.fromAddress,
          subject: args.subject,
          body: args.body,
          messageKey: args.messageKey,
          ...(args.inReplyTo !== undefined
            ? { inReplyTo: args.inReplyTo }
            : {}),
          ...(args.refs !== undefined ? { refs: [...args.refs] } : {}),
        },
        bus,
      );
    },

    async writeOutbound(args) {
      const frameArgs: Parameters<typeof buildMailFrame>[0] = {
        from: args.fromAddress,
        to: args.address,
        subject: args.subject,
        body: args.body,
        messageId: generateMailboxMessageId(args.fromAddress),
      };
      if (args.inReplyTo !== undefined) frameArgs.inReplyTo = args.inReplyTo;
      const raw = buildMailFrame(frameArgs);
      assertMailboxFrameBytes(raw);

      const insertedId = await db.transaction(async (tx) => {
        const rows = await tx
          .insert(principalMail)
          .values({
            tenantId: args.tenantId,
            principalId: args.principalId,
            address: args.address,
            direction: "outbound",
            raw: Buffer.from(raw),
            subject: args.subject,
            fromAddress: args.fromAddress,
            messageKey: args.messageKey,
            refs: args.refs !== undefined ? [...args.refs] : null,
          })
          .onConflictDoNothing({
            target: [
              principalMail.tenantId,
              principalMail.principalId,
              principalMail.messageKey,
            ],
          })
          .returning({ id: principalMail.id });
        const row = rows[0];
        if (row === undefined) return undefined;
        await tx.insert(mailbox).values({
          id: row.id,
          tenantId: args.tenantId,
          principalId: args.principalId,
        });
        return row.id;
      });

      if (insertedId === undefined) return null;
      if (bus) {
        try {
          bus.publish(
            { tenantId: args.tenantId, principalId: args.principalId },
            { type: "mailbox", id: insertedId, op: "create" },
          );
        } catch {
          // report-error-ignore: best-effort live signal, same posture as
          // `writeMailboxMessage`'s own `publishMailboxEvent` — a publish
          // failure never turns a committed write into a caller-visible
          // error; the durable row is already inserted.
        }
      }
      return { id: insertedId };
    },
  };
}

export type MailboxFanoutDeps = {
  readonly writer: MailboxWriter;
  /**
   * The subset of `candidateIds` that name a real principal in
   * `tenantId` — the host's own control-plane check (Interchange's
   * `principal` table). A participant address whose principal this
   * returns nothing for is reported and skipped rather than attempted:
   * `@corbits/mailbox`'s FK would refuse the insert anyway, but as a
   * database error deep in a transaction rather than a name a person
   * reading the report can act on.
   */
  readonly resolveKnownPrincipalIds: (
    tenantId: string,
    candidateIds: readonly string[],
  ) => Promise<ReadonlySet<string>>;
};

export type WriteChatMailboxFanoutInput = {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly senderAddress: string;
  readonly senderPrincipalId: string;
  readonly participants: readonly ParticipantRecord[];
  /** This row's own RFC 5322 `Message-ID` (`mailMessageIdFor`). */
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly subject: string;
  readonly body: string;
};

/** The human participants of a workbench, by their bare principal id —
 * a human's own participant address is never suffixed with a domain
 * (see `workbench-service.ts`'s member-add path), unlike an agent's. */
function humanPrincipalIds(
  participants: readonly ParticipantRecord[],
): readonly string[] {
  return participants
    .filter((participant) => !isAgentAddress(participant.address))
    .map((participant) => participant.address);
}

/**
 * Writes the sent message into every human participant's mailbox: an
 * "outbound" copy in the sender's own, an "inbound" copy in every other
 * human's, all sharing this row's Message-ID and its workbench ref.
 * Throws when a write to a KNOWN principal's mailbox fails — the caller
 * must not report the send as fully delivered when it wasn't.
 */
export async function writeChatMailboxFanout(
  deps: MailboxFanoutDeps,
  input: WriteChatMailboxFanoutInput,
): Promise<void> {
  const domain = domainOf(input.senderAddress);
  if (domain === undefined) {
    const err = new Error(
      `sender address "${input.senderAddress}" has no domain to address a mailbox fan-out from`,
    );
    reportError(err, {
      operation: "chat.mailboxFanout.resolveDomain",
      tenantId: input.tenantId,
      roomId: input.workbenchId,
    });
    throw err;
  }

  const candidateIds = new Set(humanPrincipalIds(input.participants));
  candidateIds.add(input.senderPrincipalId);
  const candidateList = [...candidateIds];

  const known = await deps.resolveKnownPrincipalIds(
    input.tenantId,
    candidateList,
  );

  const refs: MailboxRef[] = [{ kind: "workbench", id: input.workbenchId }];

  for (const principalId of candidateList) {
    if (!known.has(principalId)) {
      reportError(new Error(`no principal "${principalId}" in tenant`), {
        operation: "chat.mailboxFanout.resolveParticipant",
        tenantId: input.tenantId,
        roomId: input.workbenchId,
        extra: { principalId },
      });
      continue;
    }

    const address = `${principalId}@${domain}`;
    const writeArgs: MailboxWriteArgs = {
      tenantId: input.tenantId,
      principalId,
      address,
      fromAddress: input.senderAddress,
      subject: input.subject,
      body: input.body,
      messageKey: input.messageId,
      refs,
      ...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo } : {}),
    };
    try {
      if (principalId === input.senderPrincipalId) {
        await deps.writer.writeOutbound(writeArgs);
      } else {
        await deps.writer.writeInbound(writeArgs);
      }
    } catch (err) {
      reportError(err, {
        operation: "chat.mailboxFanout.write",
        tenantId: input.tenantId,
        roomId: input.workbenchId,
        extra: { principalId, messageId: input.messageId },
      });
      throw err;
    }
  }
}

/** A plain-text rendering of a message's parts, for the mailbox frame's
 * body — the same set of `TextPart`s a mention scan reads, joined the
 * way a person would read the message top to bottom. */
export function mailboxBodyOf(
  parts: readonly { kind: string; text?: string }[],
): string {
  return parts
    .filter(
      (part): part is { kind: "text"; text: string } =>
        part.kind === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n\n");
}

/** A short subject line derived from a message's body: its first line,
 * clipped to a conventional mail-subject length. */
export function mailboxSubjectOf(body: string): string {
  const firstLine = body.split("\n")[0]?.trim() ?? "";
  const MAX_SUBJECT_LENGTH = 78;
  return firstLine.length > MAX_SUBJECT_LENGTH
    ? `${firstLine.slice(0, MAX_SUBJECT_LENGTH - 1)}…`
    : firstLine || "(no subject)";
}
