// The room's timeline read straight off native mail (CL-7594): a
// workbench's messages ARE the `@corbits/mailbox` frames carrying its
// workbench ref, and this store maps those frames back onto `RoomMessage`.
// Rich rendering comes from the `message_parts` sidecar (see
// `./message-parts.ts`); a frame with no sidecar row renders its text-only
// fallback, never an error — which is also what pre-cutover frames read as,
// since there is deliberately no backfill.
//
// Reads are principal-scoped exactly like the mailbox they read: the
// caller's own copies are what its timeline shows, so `listMessages` and
// `listActivity` both take the reader's `principalId`. Single-frame lookups
// (`getMessage`, `getMessages`, `findByMailMessageId`) resolve tenant-wide —
// every copy of a frame shares its Message-ID and headers, so any copy maps
// the same — except where the caller already has a reader, in which case it
// passes it through.
//
// The mailbox-savvy seams (`listWorkbenchFrames`, `readFrame`, `findFrame`,
// `countFramesSince`, `resolveRunIds`, `resolveSenderNames`) are implemented
// once at the hub root; this package owns only the mapping. That keeps the
// bridge narrow: everything the hub must know about mail lives in one place,
// and everything chat knows about rooms stays here.
import { localPartOf } from "./agent-address";
import { isAgentAddress } from "./mentions";
import {
  mailMessageIdFor,
  parentMailMessageId,
  rowIdFromMailMessageId,
} from "./mail-headers";
import type { MessagePartsStore } from "./message-parts";
import type { Part } from "./parts";
import {
  pageOf,
  summaryOf,
  type ListedRoomMessages,
  type RoomActivitySummary,
  type RoomMessage,
  type RoomMessageStore,
} from "./room-messages";

export interface NativeTimelineFrame {
  /** The reader's own `principal_mail` row id for this copy. */
  readonly id: string;
  /** The frame's RFC 5322 `Message-ID`, shared by every copy. */
  readonly messageId: string;
  readonly fromAddress: string;
  readonly date: string;
  readonly direction: "inbound" | "outbound";
  readonly inReplyTo?: string;
  readonly subject?: string;
  /** Delivery descriptors ride here — see `./threads-native.ts`. */
  readonly refs: readonly {
    readonly kind: string;
    readonly id: string;
    readonly label?: string;
  }[];
  /**
   * Text-only fallback for a frame with no sidecar row: the frame's own
   * body (or snippet), present only when the seam already had it in hand.
   * Absent means no fallback text is known — the frame reads empty, never
   * an error.
   */
  readonly fallbackText?: string;
}

export interface NativeWorkbenchFrames {
  readonly frames: readonly NativeTimelineFrame[];
  readonly nextCursor?: string;
}

export interface NativeTimelineDeps {
  /**
   * One page of the reader's own frames carrying the workbench ref, newest
   * first, keyset-paged on the same opaque cursor this returns. Implemented
   * at the hub root over `@corbits/mailbox`'s thread walk plus one refs
   * query per page.
   */
  readonly listWorkbenchFrames: (
    tenantId: string,
    principalId: string,
    workbenchId: string,
    cursor?: string,
  ) => Promise<NativeWorkbenchFrames>;
  /**
   * The tenant's mail domain, to frame msg_ ids as `Message-ID`s when no
   * reader is in scope (system lookups by msg_ id).
   */
  readonly resolveTenantDomain: (tenantId: string) => Promise<string>;
  /**
   * The reader's own copy of one frame by its msg_ id, for `getMessage`.
   * Undefined when the reader holds no copy — which the caller reports
   * rather than guessing from another principal's mailbox.
   */
  readonly readFrame: (
    tenantId: string,
    principalId: string,
    messageId: string,
  ) => Promise<NativeTimelineFrame | undefined>;
  /**
   * Any copy of the frame a `Message-ID` names, tenant-wide, for
   * `findByMailMessageId` and the correlation reads. Every copy shares the
   * Message-ID and headers, so any copy maps the same.
   */
  readonly findFrame: (
    tenantId: string,
    mailMessageId: string,
  ) => Promise<NativeTimelineFrame | undefined>;
  /**
   * Any copies of the frames a list of msg_ ids names, tenant-wide, for
   * `getMessages` (pin checks, reaction targets). Returns only the frames
   * that resolve — a missing id is absent, never an error.
   */
  readonly findFrames: (
    tenantId: string,
    messageIds: readonly string[],
  ) => Promise<readonly NativeTimelineFrame[]>;
  /**
   * How many of the reader's frames in the workbench are newer than
   * `sinceCreatedAt`, for `listActivity` unread counts. Counts the same
   * rows `listWorkbenchFrames` pages over.
   */
  readonly countFramesSince: (
    tenantId: string,
    principalId: string,
    workbenchId: string,
    sinceCreatedAt: string | undefined,
  ) => Promise<number>;
  /**
   * The agent run each frame came out of, by frame Message-ID — read off
   * `agent_turns`' surviving `reply_message_id`, in one query. Frames with
   * no recorded run are absent from the map, never null-valued.
   */
  readonly resolveRunIds: (
    tenantId: string,
    mailMessageIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
  /**
   * Display names for a page's sender addresses, by bare address — the
   * principal directory first, workbench participants (agents included)
   * second. Unresolvable addresses are absent; the frame's own address is
   * then all the timeline shows.
   */
  readonly resolveSenderNames: (
    tenantId: string,
    addresses: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
  readonly parts: MessagePartsStore;
}


function textFallbackParts(text: string): Part[] {
  return [{ kind: "text", text }];
}

function senderPrincipalIdOf(
  frame: NativeTimelineFrame,
  readerPrincipalId: string | undefined,
): string | null {
  if (isAgentAddress(frame.fromAddress)) return null;
  if (
    frame.direction === "outbound" &&
    readerPrincipalId !== undefined &&
    frame.fromAddress.length > 0
  ) {
    return readerPrincipalId;
  }
  const local = localPartOf(frame.fromAddress);
  return local.length > 0 ? local : null;
}

export function toNativeRoomMessage(
  frame: NativeTimelineFrame,
  input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    readonly parts: readonly Part[] | null;
    readonly runId: string | undefined;
    readonly senderName: string | undefined;
    readonly threadId: string | null;
    readonly readerPrincipalId?: string;
  },
): RoomMessage {
  return {
    id: rowIdFromMailMessageId(frame.messageId),
    workbenchId: input.workbenchId,
    createdAt: frame.date,
    sender: {
      name: input.senderName ?? null,
      address: frame.fromAddress,
    },
    senderPrincipalId: senderPrincipalIdOf(frame, input.readerPrincipalId),
    runId: input.runId ?? null,
    threadId: input.threadId,
    mailMessageId: frame.messageId,
    parts:
      input.parts !== null
        ? [...input.parts]
        : frame.fallbackText !== undefined
          ? textFallbackParts(frame.fallbackText)
          : [],
  };
}

/**
 * Maps one page of native frames onto timeline messages: one sidecar batch
 * for the page's parts, one run-id batch, one sender-name batch. Thread
 * ids come from the caller-supplied descriptor fn — descriptors are pure
 * (see `./threads-native.ts`), so mapping never queries per frame.
 */
export async function mapNativeFrames(
  deps: NativeTimelineDeps,
  input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    readonly frames: readonly NativeTimelineFrame[];
    readonly readerPrincipalId?: string;
    readonly threadIdOf: (
      frame: NativeTimelineFrame,
    ) => string | null | Promise<string | null>;
  },
): Promise<readonly RoomMessage[]> {
  if (input.frames.length === 0) return [];
  const mailMessageIds = input.frames.map((frame) => frame.messageId);
  const [sidecarRows, runIds, names] = await Promise.all([
    deps.parts.listMessagePartsForFrames(input.tenantId, mailMessageIds),
    deps.resolveRunIds(input.tenantId, mailMessageIds),
    deps.resolveSenderNames(
      input.tenantId,
      [...new Set(input.frames.map((frame) => frame.fromAddress))].filter(
        (address) => address.length > 0,
      ),
    ),
  ]);
  const partsByMessageId = new Map(
    sidecarRows.map((row) => [row.mailMessageId, row.parts] as const),
  );
  return Promise.all(
    input.frames.map(async (frame) => {
      const stored = partsByMessageId.get(frame.messageId) ?? null;
      // Tenant-wide lookups resolve frames whose workbench ref the caller
      // never named (pin checks, correlation reads): the frame's own ref is
      // the authority, and it agrees with the requested workbench whenever
      // the caller did name one.
      const workbenchId =
        frame.refs.find((ref) => ref.kind === "workbench")?.id ??
        input.workbenchId;
      return toNativeRoomMessage(frame, {
        tenantId: input.tenantId,
        workbenchId,
        parts: stored !== null ? [...stored] : null,
        runId: runIds.get(frame.messageId),
        senderName: names.get(frame.fromAddress),
        threadId: await input.threadIdOf(frame),
        ...(input.readerPrincipalId !== undefined
          ? { readerPrincipalId: input.readerPrincipalId }
          : {}),
      });
    }),
  );
}

/** The delivery ref that promotes a frame out of the thread its headers
 * would otherwise put it in — see `./threads-native.ts`. */
export function deliveryRefOf(frame: Pick<NativeTimelineFrame, "refs">):
  | { readonly id: string; readonly label?: string }
  | undefined {
  return frame.refs.find((ref) => ref.kind === "chat-delivery");
}

/**
 * Creates the native `RoomMessageStore`: every read off the reader's (or,
 * for single-frame lookups, any) mailbox copies plus the parts sidecar.
 * `threadIdOf` is the descriptor derivation from `./threads-native.ts`,
 * injected so this module never imports the thread scheme itself.
 *
 * Writes (`insertMessage`, `stampMailMessageId`, `deleteMessage`) are gone:
 * sends are mailbox-first now (see `sendWorkbenchMessage` in
 * `./workbench-service.ts`), so there is no row to insert, stamp, or delete
 * on failure — the mailbox batch is the one durable write.
 */
export function createNativeRoomMessageStore(
  deps: NativeTimelineDeps,
  thread: {
    readonly threadIdOf: (
      tenantId: string,
      workbenchId: string,
      frame: Pick<NativeTimelineFrame, "messageId" | "inReplyTo" | "refs">,
    ) => Promise<string | null>;
  },
): RoomMessageStore {
  async function mapPage(
    tenantId: string,
    workbenchId: string,
    frames: readonly NativeTimelineFrame[],
    readerPrincipalId?: string,
  ): Promise<readonly RoomMessage[]> {
    return mapNativeFrames(deps, {
      tenantId,
      workbenchId,
      frames,
      ...(readerPrincipalId !== undefined ? { readerPrincipalId } : {}),
      threadIdOf: (frame) => thread.threadIdOf(tenantId, workbenchId, frame),
    });
  }

  return {
    async insertMessage() {
      throw new Error(
        "insertMessage is gone: sends write mailbox frames first (CL-7594), there is no timeline row to insert",
      );
    },
    async stampMailMessageId() {
      throw new Error(
        "stampMailMessageId is gone: a frame's Message-ID is minted at send time (CL-7594), never stamped after",
      );
    },
    async deleteMessage() {
      throw new Error(
        "deleteMessage is gone: mailbox-first sends have no just-inserted row to roll back (CL-7594)",
      );
    },

    async listMessages(input) {
      const principalId = input.principalId;
      if (principalId === undefined) {
        throw new Error(
          "listMessages needs the reader's principalId: the timeline reads its own mailbox copies (CL-7594)",
        );
      }
      const page = await deps.listWorkbenchFrames(
        input.tenantId,
        principalId,
        input.workbenchId,
        input.cursor,
      );
      const items = await mapPage(
        input.tenantId,
        input.workbenchId,
        page.frames,
        principalId,
      );
      return pageOfWithCursor(items, page.nextCursor);
    },

    async getMessages(input) {
      const frames = await deps.findFrames(input.tenantId, input.messageIds);
      const wanted = new Set(input.messageIds);
      const belonging = frames.filter((frame) =>
        wanted.has(rowIdFromMailMessageId(frame.messageId)),
      );
      return mapPage(input.tenantId, "", belonging);
    },

    async getMessage(input) {
      const principalId = input.principalId;
      const frame =
        principalId !== undefined
          ? await deps.readFrame(input.tenantId, principalId, input.messageId)
          : await deps.findFrame(
              input.tenantId,
              // System lookups hold only the msg_ id: frame it the way
              // sends mint it, then resolve tenant-wide.
              mailMessageIdFor(
                input.messageId,
                await deps.resolveTenantDomain(input.tenantId),
              ),
            );
      if (frame === undefined) return undefined;
      const [mapped] = await mapPage(
        input.tenantId,
        input.workbenchId,
        [frame],
        principalId,
      );
      return mapped;
    },

    async findByMailMessageId(input) {
      const frame = await deps.findFrame(input.tenantId, input.mailMessageId);
      if (frame === undefined) return undefined;
      const [mapped] = await mapPage(input.tenantId, "", [frame]);
      return mapped;
    },

    async listActivity(input) {
      const principalId = input.principalId;
      if (principalId === undefined) {
        throw new Error(
          "listActivity needs the reader's principalId: unread counts read its own mailbox copies (CL-7594)",
        );
      }
      const result: Record<string, RoomActivitySummary> = {};
      await Promise.all(
        input.workbenches.map(async (workbench) => {
          const [page, unreadCount] = await Promise.all([
            deps.listWorkbenchFrames(
              input.tenantId,
              principalId,
              workbench.workbenchId,
              undefined,
            ),
            deps.countFramesSince(
              input.tenantId,
              principalId,
              workbench.workbenchId,
              workbench.sinceCreatedAt,
            ),
          ]);
          const newest = page.frames[0];
          if (newest === undefined) return;
          // The summary preview sometimes reads back past the newest
          // message; map the page head the way the legacy store mapped its
          // preview page.
          const mapped = await mapPage(
            input.tenantId,
            workbench.workbenchId,
            page.frames.slice(0, 5),
            principalId,
          );
          const [first] = mapped;
          if (first === undefined) return;
          result[workbench.workbenchId] = summaryOf(first, unreadCount, mapped);
        }),
      );
      return result;
    },
  };
}

function pageOfWithCursor(
  items: readonly RoomMessage[],
  nextCursor: string | undefined,
): ListedRoomMessages {
  const page = pageOf(items);
  // `pageOf` slices at its own page size; the seam already sized the page,
  // so only adopt the seam's cursor when there is one — never invent a
  // second page boundary on top of it.
  if (nextCursor === undefined) return { items: page.items };
  return { items: page.items, nextCursor };
}

/** The nearest ancestor a frame answers, for descriptor derivation. */
export function parentOfFrame(
  frame: Pick<NativeTimelineFrame, "inReplyTo">,
): string | undefined {
  return parentMailMessageId({ inReplyTo: frame.inReplyTo });
}
