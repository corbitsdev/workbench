// Assembling one turn's context from message rows (CL-6329). A turn is
// asked of an agent with the conversation it is being dropped into, and
// that conversation is the room's own rows — not a mailbox, not the
// agent's memory. Split out of `./workbench-service.ts`, where it grew
// up as mention-fan-out plumbing, because the turn seam is now its own
// concern: it is thread-scoped (a sub-thread's turn sees that
// sub-thread, never the whole room), and it honors the workbench's
// resolved context-window setting.
//
// `./workbench-context.ts` remains the pure formatter underneath; this
// module is the reader that feeds it.
import { getLogger } from "@intx/log";

import { localPartOf } from "./agent-address";
import { isAgentAddress } from "./mentions";
import type { Part } from "./parts";
import type { ParticipantRecord } from "./participants";
import type { RoomMessage, RoomMessageStore } from "./room-messages";
import {
  buildDroppedRecap,
  DROPPED_RECAP_LOOKBACK,
  renderWorkbenchContext,
  type WorkbenchContextItem,
} from "./workbench-context";

const contextLog = getLogger(["chat", "turn-context"]);

/**
 * Restricts a turn's context to one thread. Thread membership lives in
 * its own store (`./threads.ts`), not on the message row, so the caller
 * injects the resolver rather than this module reaching for a second
 * store.
 */
export interface TurnContextThreadScope {
  readonly threadId: string;
  threadIdOf(messageId: string): string;
}

/**
 * The sender label a context line renders under: `@handle` for a known
 * agent participant, `"user"` for anything else. Never a raw address or
 * principal id — this text reaches a model prompt and possibly logs.
 */
export function labelForSender(
  address: string,
  participants: readonly ParticipantRecord[],
): string {
  // Every sender address carries a full `id@domain` regardless of kind,
  // so an agent sender is recognized by matching its local part against
  // a known *agent* participant's — never by the mere presence of "@".
  const known = participants.find(
    (participant) =>
      isAgentAddress(participant.address) &&
      localPartOf(participant.address) === localPartOf(address),
  );
  return known !== undefined ? `@${known.handle}` : "user";
}

/**
 * One message as a context item, or `undefined` for a message with no
 * text parts — an event-only message contributes nothing a context block
 * can render.
 */
export function contextItemFor(
  message: RoomMessage,
  participants: readonly ParticipantRecord[],
): WorkbenchContextItem | undefined {
  const texts = message.parts
    .filter(
      (part): part is Extract<Part, { kind: "text" }> => part.kind === "text",
    )
    .map((part) => part.text);
  if (texts.length === 0) return undefined;
  return {
    label: labelForSender(message.sender.address, participants),
    text: texts.join(" "),
  };
}

export interface AssembleTurnContextInput {
  readonly roomMessages: Pick<RoomMessageStore, "listMessages">;
  readonly tenantId: string;
  readonly workbenchId: string;
  /** The message this turn is answering; never re-rendered as context. */
  readonly excludeMessageId: string;
  readonly participants: readonly ParticipantRecord[];
  /** The workbench's resolved `chat/contextWindow` — 0 loads nothing. */
  readonly contextWindow: number;
  /** Absent means the whole room; present narrows to one thread. */
  readonly thread?: TurnContextThreadScope;
}

/**
 * Builds the plain-text context block a turn is asked with: the most
 * recent messages of the turn's own thread, oldest first, capped to the
 * resolved context window, with everything the window dropped folded
 * into one bounded recap entry (CL-6204) rather than silently vanishing.
 *
 * The listing is paged out to `contextWindow + DROPPED_RECAP_LOOKBACK` —
 * enough for the window plus the recap's own bounded lookback, never
 * further: a longer dropped span is still counted from what was fetched,
 * just marked as a lower bound (`moreBeyondFold`).
 *
 * Returns `undefined` when there is nothing to show at all, or when the
 * timeline fails to load: that failure must never break the turn, so it
 * is logged and swallowed here and the agent is asked un-situated.
 */
export async function assembleTurnContext(
  input: AssembleTurnContextInput,
): Promise<string | undefined> {
  if (input.contextWindow === 0) return undefined;
  try {
    const fetchCap = input.contextWindow + DROPPED_RECAP_LOOKBACK;
    const inScope = (message: RoomMessage): boolean =>
      message.id !== input.excludeMessageId &&
      (input.thread === undefined ||
        input.thread.threadIdOf(message.id) === input.thread.threadId);

    const newestFirst: RoomMessage[] = [];
    let cursor: string | undefined;
    do {
      const page = await input.roomMessages.listMessages(
        cursor === undefined
          ? { tenantId: input.tenantId, workbenchId: input.workbenchId }
          : {
              tenantId: input.tenantId,
              workbenchId: input.workbenchId,
              cursor,
            },
      );
      newestFirst.push(...page.items.filter(inScope));
      cursor = page.nextCursor;
    } while (cursor !== undefined && newestFirst.length < fetchCap);

    const considered = newestFirst.slice(0, fetchCap);
    const moreBeyondFold = cursor !== undefined;

    const windowed = considered.slice(0, input.contextWindow);
    const dropped = considered.slice(input.contextWindow);
    const wasDropped = dropped.length > 0 || moreBeyondFold;

    const items: WorkbenchContextItem[] = [];
    for (const message of [...windowed].reverse()) {
      const item = contextItemFor(message, input.participants);
      if (item !== undefined) items.push(item);
    }

    let recap: WorkbenchContextItem | undefined;
    if (wasDropped) {
      const droppedItems: WorkbenchContextItem[] = [];
      for (const message of dropped) {
        const item = contextItemFor(message, input.participants);
        if (item !== undefined) droppedItems.push(item);
      }
      const humanTexts = [...droppedItems]
        .reverse()
        .filter((item) => item.label === "user")
        .map((item) => item.text);
      const oldestDropped = dropped[dropped.length - 1];
      const newestDropped = dropped[0];
      recap =
        oldestDropped !== undefined && newestDropped !== undefined
          ? buildDroppedRecap({
              droppedCount: dropped.length,
              moreBeyondFold,
              humanTexts,
              firstDate: oldestDropped.createdAt,
              lastDate: newestDropped.createdAt,
            })
          : buildDroppedRecap({
              droppedCount: dropped.length,
              moreBeyondFold,
              humanTexts,
            });
    }

    if (items.length === 0 && recap === undefined) return undefined;
    return recap !== undefined
      ? renderWorkbenchContext({ items, recap })
      : renderWorkbenchContext({ items });
  } catch (err) {
    contextLog.warn`failed to assemble turn context on workbench ${input.workbenchId}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return undefined;
  }
}
