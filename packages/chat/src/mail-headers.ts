// RFC 5322 threading headers for a workbench timeline row (CL-7104).
//
// Chat is a mail thread: a message row dispatched to an agent carries its
// own `Message-ID`, and the reply that answers it names that id in
// `In-Reply-To` / `References`. Correlation is those headers and nothing
// else — no `Interchange-Correlation-ID`, no reply-to-address heuristic.
//
// A row's Message-ID is derived, never minted separately: `<rowId@domain>`
// over the row's own primary key and the mail domain the workbench's
// participants are addressed in. Deriving it means the same row always
// produces the same header, so stamping it twice is a no-op and reading a
// header back names exactly one row.
import { reportError } from "@corbits/error-sink";
import { localPartOf } from "./agent-address";
import type { ChatStore } from "./store";
import type { RoomMessageStore } from "./room-messages";

/** The RFC 5322 `Message-ID` for a timeline row: `<rowId@domain>`. */
export function mailMessageIdFor(rowId: string, domain: string): string {
  return `<${rowId}@${domain}>`;
}

/**
 * The timeline row a `Message-ID` names — the inverse of
 * `mailMessageIdFor`. A value with no `<...>` framing, or no `@`, is
 * returned unchanged, so an id minted by any other transport simply
 * misses the row lookup rather than crashing it.
 */
export function rowIdFromMailMessageId(header: string): string {
  const framed =
    header.startsWith("<") && header.endsWith(">") && header.length > 2
      ? header.slice(1, -1)
      : header;
  return localPartOf(framed);
}

/**
 * The threading headers for a row being dispatched as mail. `ancestors`
 * is the row's parent chain, root first (see `mailAncestryOf` in
 * `./threads.ts`); `References` is exactly that chain and `In-Reply-To`
 * is its tail, per RFC 5322. A root-feed row has neither.
 */
export function mailThreadHeaders(input: {
  readonly rowId: string;
  readonly domain: string;
  readonly ancestors: readonly string[];
}): {
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
} {
  const messageId = mailMessageIdFor(input.rowId, input.domain);
  const references = input.ancestors.map((ancestor) =>
    mailMessageIdFor(ancestor, input.domain),
  );
  const inReplyTo = references[references.length - 1];
  return {
    messageId,
    ...(inReplyTo !== undefined ? { inReplyTo } : {}),
    ...(references.length > 0 ? { references } : {}),
  };
}

/**
 * The `Message-ID` an inbound reply answers: `In-Reply-To` when it has
 * one, otherwise the tail of `References` — the nearest ancestor either
 * header names. Undefined when the reply threads under nothing at all,
 * which the caller must report rather than guess a parent for.
 */
export function parentMailMessageId(headers: {
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
}): string | undefined {
  if (headers.inReplyTo !== undefined && headers.inReplyTo !== "") {
    return headers.inReplyTo;
  }
  const references = headers.references ?? [];
  const tail = references[references.length - 1];
  return tail !== undefined && tail !== "" ? tail : undefined;
}

/**
 * Splits a raw `References` header value into its Message-IDs.
 * RFC 5322 separates them by whitespace (folding included), so any run
 * of whitespace is the separator and empty segments are dropped.
 */
export function parseReferences(value: string): readonly string[] {
  return value.split(/\s+/).filter((entry) => entry.length > 0);
}

/**
 * Resolves the workbench an outbound agent frame belongs to, for stamping
 * onto its mailbox rows (CL-7449).
 *
 * Header-first: `In-Reply-To` (or, failing that, the newest `References`
 * entry -- see `parentMailMessageId`) names the timeline row the frame
 * answers, and that row's own `workbenchId` is authoritative -- an agent
 * can be a participant of several workbenches at once, so which one THIS
 * reply belongs to is a fact of the row it threads under, never a guess
 * from the sender address alone.
 *
 * Only when no header resolves (a root-feed frame, or one answering a row
 * mail never dispatched) does this fall back to
 * `findWorkbenchIdsByParticipantAddress` -- and only takes that scan's
 * answer when it names EXACTLY one workbench. Zero matches (a plain
 * workflow mail, no chat participation at all) and several matches (the
 * ambiguous case the header-first path exists to avoid) both stamp
 * nothing and report once, so the gap is visible rather than silently
 * guessed at.
 */
export async function resolveWorkbenchIdForAgentFrame(
  store: {
    readonly chatStore: ChatStore;
    readonly roomMessages: Pick<RoomMessageStore, "findByMailMessageId">;
  },
  tenantId: string,
  args: {
    readonly senderAddress: string;
    readonly inReplyTo?: string;
    readonly references?: readonly string[];
  },
): Promise<string | undefined> {
  const parentId = parentMailMessageId(args);
  if (parentId !== undefined) {
    const row = await store.roomMessages.findByMailMessageId({
      tenantId,
      mailMessageId: parentId,
    });
    if (row !== undefined) return row.workbenchId;
  }

  const workbenchIds =
    await store.chatStore.findWorkbenchIdsByParticipantAddress(
      tenantId,
      args.senderAddress,
    );
  if (workbenchIds.length === 1) return workbenchIds[0];

  reportError(
    new Error(
      workbenchIds.length === 0
        ? "agent frame sender participates in no workbench"
        : "agent frame sender participates in more than one workbench",
    ),
    {
      operation: "mailbox_ref_unresolved",
      tenantId,
      extra: {
        senderAddress: args.senderAddress,
        workbenchCount: workbenchIds.length,
      },
    },
  );
  return undefined;
}
