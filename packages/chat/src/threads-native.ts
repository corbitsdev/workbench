// Threads as descriptors, not rows (CL-7594): with `workbench_threads`
// and `workbench_thread_messages` dropped, a thread is a deterministic id
// derived from its anchor — the same anchor always names the same thread,
// so opening is idempotent by construction and nothing is ever written.
//
// A thread's ANCESTRY is structural (parsed out of the id), but a frame's
// MEMBERSHIP — which thread it reads in — comes from the frame itself:
//  1. the `chat-thread` ref a chat send stamps (exact, no lookup), then
//  2. the `chat-delivery` ref a delivery send stamps, then
//  3. the threading headers, walked at most two ancestors up (exact for
//     every shape a send can produce — see `deriveThreadId`), then
//  4. the root feed, for frames answering nothing (or nothing local).
//
// Delivery threads keep their run identity in the `chat-delivery` ref
// (`{ id: runRef, label: title }`), which is what "delivery descriptors
// from mail refs" means: the descriptor names the run, the ref carries the
// title, and `getThread` reunites them off a workbench scan.
import { localPartOf } from "./agent-address";
import {
  resolveThreadAnchor,
  ThreadDepthCapError,
  type CreateDeliveryThreadInput,
  type ForkThreadInput,
  type OpenReplyThreadInput,
  type ThreadKind,
  type ThreadStore,
  type WorkbenchThread,
} from "./threads";

export const CHAT_THREAD_REF_KIND = "chat-thread";
export const CHAT_DELIVERY_REF_KIND = "chat-delivery";

const ROOT_PREFIX = "thr_root_";
const REPLY_PREFIX = "thr_reply_";
const SUB_PREFIX = "thr_sub_";
const DELIVERY_PREFIX = "thr_delivery_";

export type ThreadDescriptor =
  | { readonly kind: "root"; readonly workbenchId: string }
  | { readonly kind: "reply"; readonly parentMessageId: string }
  | {
      readonly kind: "sub";
      readonly parentThreadId: string;
      readonly anchorMessageId: string;
    }
  | { readonly kind: "delivery"; readonly runRef: string };

/** The root feed's thread: one per workbench, never written. */
export function rootThreadId(workbenchId: string): string {
  return `${ROOT_PREFIX}${workbenchId}`;
}

/** The depth-1 reply thread anchored on a message: idempotent — opening
 * twice names the same thread, which is what makes `openReplyThread` a
 * pure constructor. */
export function replyThreadId(parentMessageId: string): string {
  return `${REPLY_PREFIX}${parentMessageId}`;
}

/** A depth-2 sub-thread: the depth-1 parent's descriptor plus the anchor
 * message. The anchor is split back off on the LAST `_msg_` — msg_ ids
 * never contain one themselves, so the parent (which may itself embed
 * underscores, e.g. a delivery run ref) stays intact. */
export function subThreadId(
  parentThreadId: string,
  anchorMessageId: string,
): string {
  return `${SUB_PREFIX}${parentThreadId}_${anchorMessageId}`;
}

/** A routine-run delivery thread: the run ref, unescaped — parsing strips
 * the prefix and takes the rest whole, so no run ref shape can break it. */
export function deliveryThreadId(runRef: string): string {
  return `${DELIVERY_PREFIX}${runRef}`;
}

/** Parses a descriptor back into its anchor. Undefined for anything that
 * was never a descriptor — notably the legacy `thr_<uuid>` rows, which
 * read as unknown rather than guessing a thread. */
export function parseThreadDescriptor(threadId: string): ThreadDescriptor | undefined {
  if (threadId.startsWith(ROOT_PREFIX) && threadId.length > ROOT_PREFIX.length) {
    return { kind: "root", workbenchId: threadId.slice(ROOT_PREFIX.length) };
  }
  if (
    threadId.startsWith(REPLY_PREFIX) &&
    threadId.length > REPLY_PREFIX.length
  ) {
    return {
      kind: "reply",
      parentMessageId: threadId.slice(REPLY_PREFIX.length),
    };
  }
  if (
    threadId.startsWith(DELIVERY_PREFIX) &&
    threadId.length > DELIVERY_PREFIX.length
  ) {
    return { kind: "delivery", runRef: threadId.slice(DELIVERY_PREFIX.length) };
  }
  if (threadId.startsWith(SUB_PREFIX)) {
    const rest = threadId.slice(SUB_PREFIX.length);
    const anchorAt = rest.lastIndexOf("_msg_");
    if (anchorAt < 0) return undefined;
    const parentThreadId = rest.slice(0, anchorAt);
    const anchorMessageId = rest.slice(anchorAt + 1);
    const parent = parseThreadDescriptor(parentThreadId);
    if (parent === undefined || parent.kind === "root" || parent.kind === "sub") {
      return undefined;
    }
    return { kind: "sub", parentThreadId, anchorMessageId };
  }
  return undefined;
}

function depthOf(descriptor: ThreadDescriptor): number {
  switch (descriptor.kind) {
    case "root":
      return 0;
    case "reply":
    case "delivery":
      return 1;
    case "sub":
      return 2;
  }
}

/**
 * The parent chain of a thread, root first — the descriptor successor to
 * `mailAncestryOf`: a reply thread answers its anchor message, a sub-thread
 * answers its parent's anchor then its own. Empty for the root feed and
 * delivery threads, which answer nothing. Bounded by the two-level cap, so
 * the chain is never longer than two entries.
 */
export function ancestryOfDescriptor(threadId: string): readonly string[] {
  const descriptor = parseThreadDescriptor(threadId);
  if (descriptor === undefined) return [];
  switch (descriptor.kind) {
    case "root":
    case "delivery":
      return [];
    case "reply":
      return [descriptor.parentMessageId];
    case "sub": {
      const parent = parseThreadDescriptor(descriptor.parentThreadId);
      if (parent === undefined) return [descriptor.anchorMessageId];
      if (parent.kind === "reply") {
        return [parent.parentMessageId, descriptor.anchorMessageId];
      }
      return [descriptor.anchorMessageId];
    }
  }
}

/** The `Message-ID` values `mailThreadHeaders` wants for a thread: the
 * descriptor ancestry framed for the tenant's domain. Unknown (legacy)
 * thread ids dispatch headerless — a root-feed send, never a guess. */
export function threadAncestryMessageIds(
  threadId: string | null,
  mailMessageIdForId: (rowId: string) => string,
): readonly string[] {
  if (threadId === null) return [];
  return ancestryOfDescriptor(threadId).map((ancestor) =>
    mailMessageIdForId(ancestor),
  );
}

export interface NativeFrameHeaders {
  /** The frame's RFC 5322 `Message-ID`, shared by every copy. */
  readonly messageId: string;
  /** The msg_ id — `rowIdFromMailMessageId(messageId)`. */
  readonly msgId: string;
  readonly inReplyTo?: string;
  /** The workbench ref's id — which workbench this copy reads in. */
  readonly workbenchId: string;
  /** The `chat-thread` ref's id, stamped by chat sends. */
  readonly threadRef?: string;
  readonly deliveryRef?: { readonly id: string; readonly label?: string };
  readonly date: string;
}

export interface DescriptorThreadDeps {
  /**
   * Headers for a batch of msg_ ids, tenant-wide — any copy's headers do,
   * since every copy of a frame shares them. Implemented at the hub root
   * as one `principal_mail` query. Only the ids that resolve are present.
   */
  readonly findFrameHeaders: (
    tenantId: string,
    messageIds: readonly string[],
  ) => Promise<ReadonlyMap<string, NativeFrameHeaders>>;
  /**
   * Every frame carrying the workbench ref in the reader's own mailbox,
   * newest first. The reader scope is also what makes delivery titles
   * resolvable: `getThread` finds the frame carrying the delivery ref.
   */
  readonly listWorkbenchFrameHeaders: (
    tenantId: string,
    principalId: string,
    workbenchId: string,
  ) => Promise<readonly NativeFrameHeaders[]>;
}

/** The parent msg_ a frame answers, when the parent is a chat frame at
 * all: anything not shaped `msg_*` (foreign mail, bracket ids) threads
 * under nothing. */
export function parentMsgIdOf(frame: Pick<NativeFrameHeaders, "inReplyTo">):
  | string
  | undefined {
  const parent = frame.inReplyTo;
  if (parent === undefined || parent === "") return undefined;
  const local = localPartOf(
    parent.startsWith("<") && parent.endsWith(">") && parent.length > 2
      ? parent.slice(1, -1)
      : parent,
  );
  return local.startsWith("msg_") ? local : undefined;
}

/**
 * Which thread one frame reads in, given the workbench's headers by msg_.
 * Exact for every shape a send can produce: chat sends stamp the
 * `chat-thread` ref, delivery sends the `chat-delivery` ref, and the
 * header walk mirrors the send-time `resolveThreadAnchor` rule — a reply
 * under a root-feed message opens a reply thread, under a depth-1 thread
 * a sub-thread, under a depth-2 thread a sibling sub-thread. A parent
 * outside the map (a foreign workbench's frame, a delegation hop, a frame
 * mail never dispatched) reads in the root feed, the way unassigned rows
 * always defaulted there.
 */
export function deriveThreadId(
  frame: NativeFrameHeaders,
  byMsgId: ReadonlyMap<string, NativeFrameHeaders>,
  workbenchId: string,
): string {
  const root = rootThreadId(workbenchId);
  if (frame.threadRef !== undefined) return frame.threadRef;
  if (frame.deliveryRef !== undefined) {
    return deliveryThreadId(frame.deliveryRef.id);
  }
  const parentMessageId = parentMsgIdOf(frame);
  if (parentMessageId === undefined) return root;
  const parent = byMsgId.get(parentMessageId);
  if (parent === undefined || parent.workbenchId !== workbenchId) return root;
  const container = deriveThreadId(parent, byMsgId, workbenchId);
  const parsed = parseThreadDescriptor(container);
  if (parsed === undefined) return replyThreadId(parentMessageId);
  const depth = depthOf(parsed);
  if (depth === 0) return replyThreadId(parentMessageId);
  if (depth === 1) {
    return subThreadId(container, parentMessageId);
  }
  if (parsed.kind === "sub") {
    return subThreadId(parsed.parentThreadId, parentMessageId);
  }
  return replyThreadId(parentMessageId);
}

/** `deriveThreadId` over a closed header set — a full workbench scan
 * resolves every same-bench chain in-map, genesis included. */
export function deriveThreadIds(
  headers: readonly NativeFrameHeaders[],
  workbenchId: string,
): ReadonlyMap<string, string> {
  const byMsgId = new Map(headers.map((header) => [header.msgId, header]));
  const result = new Map<string, string>();
  for (const header of headers) {
    result.set(header.msgId, deriveThreadId(header, byMsgId, workbenchId));
  }
  return result;
}

function threadForDescriptor(
  tenantId: string,
  workbenchId: string,
  threadId: string,
  input: {
    readonly parentMessageId: string | null;
    readonly parentThreadId: string | null;
    readonly runRef: string | null;
    readonly title: string | null;
    readonly createdAt: Date;
  },
): WorkbenchThread {
  const descriptor = parseThreadDescriptor(threadId);
  const kind: ThreadKind =
    descriptor?.kind === "delivery"
      ? "delivery"
      : descriptor?.kind === "root"
        ? "root"
        : "reply";
  return {
    id: threadId,
    tenantId,
    workbenchId,
    kind,
    parentMessageId: input.parentMessageId,
    parentThreadId: input.parentThreadId,
    runRef: input.runRef,
    title: input.title,
    createdAt: input.createdAt,
  };
}

/**
 * Creates the descriptor `ThreadStore`: opens construct ids, reads derive
 * off mailbox scans, and membership writes are gone — a frame's thread is
 * stamped (chat sends) or derived (everything else), never recorded.
 *
 * `getThread` and the scans take the reader's `principalId` where they
 * must: delivery titles and thread listings resolve off the reader's own
 * copies. Ancestry-only callers (`mailAncestryOf`-style dispatch paths)
 * omit it and get structural answers — descriptors parse without mail.
 */
export function createDescriptorThreadStore(
  deps: DescriptorThreadDeps,
): ThreadStore {
  async function headersFor(
    tenantId: string,
    messageIds: readonly string[],
  ): Promise<ReadonlyMap<string, NativeFrameHeaders>> {
    if (messageIds.length === 0) return new Map();
    return deps.findFrameHeaders(tenantId, messageIds);
  }

  /** The thread a message reads in, for the depth-cap check and the fork
   * redirect: the message's own headers plus two ancestors up — the same
   * bound `threadIdForMessage` uses, and exact for every send-time shape
   * (sends cap chains at depth 2, so two hops always reach a root-feed or
   * stamped frame). Returns the thread's id with its parsed descriptor.
   */
  async function containerOfMessage(
    tenantId: string,
    workbenchId: string,
    messageId: string,
  ): Promise<{ readonly threadId: string; readonly descriptor: ThreadDescriptor }> {
    const root: ThreadDescriptor = { kind: "root", workbenchId };
    const found = await headersFor(tenantId, [messageId]);
    const header = found.get(messageId);
    if (header === undefined || header.workbenchId !== workbenchId) {
      return { threadId: rootThreadId(workbenchId), descriptor: root };
    }
    // Two hops decide the container exactly — see `threadIdForMessage`.
    const byMsgId = new Map([[messageId, header]]);
    let frontier = [header];
    for (let round = 0; round < 2; round += 1) {
      const wanted = frontier
        .map((entry) => parentMsgIdOf(entry))
        .filter(
          (parent): parent is string =>
            parent !== undefined && !byMsgId.has(parent),
        );
      if (wanted.length === 0) break;
      const more = await headersFor(tenantId, wanted);
      let grew = false;
      for (const [id, next] of more) {
        if (!byMsgId.has(id)) {
          byMsgId.set(id, next);
          grew = true;
        }
      }
      frontier = [...more.values()];
      if (!grew) break;
    }
    const threadId = deriveThreadId(header, byMsgId, workbenchId);
    // deriveThreadId only ever constructs descriptors, so this parse is
    // total — the fallback is dead code against a logic change elsewhere.
    const descriptor = parseThreadDescriptor(threadId) ?? root;
    return {
      threadId: descriptor === root ? rootThreadId(workbenchId) : threadId,
      descriptor,
    };
  }

  /** The container as a `WorkbenchThread` for `resolveThreadAnchor`: the
   * anchor rule reads the container's own parent linkage, so the thread
   * is rebuilt from the parsed descriptor — blank fields would read every
   * container as root-adjacent. */
  function containerThread(
    tenantId: string,
    workbenchId: string,
    container: { readonly threadId: string; readonly descriptor: ThreadDescriptor },
  ): WorkbenchThread {
    switch (container.descriptor.kind) {
      case "root":
        return threadForDescriptor(tenantId, workbenchId, container.threadId, {
          parentMessageId: null,
          parentThreadId: null,
          runRef: null,
          title: null,
          createdAt: new Date(0),
        });
      case "reply":
        return threadForDescriptor(tenantId, workbenchId, container.threadId, {
          parentMessageId: container.descriptor.parentMessageId,
          parentThreadId: rootThreadId(workbenchId),
          runRef: null,
          title: null,
          createdAt: new Date(0),
        });
      case "sub":
        return threadForDescriptor(tenantId, workbenchId, container.threadId, {
          parentMessageId: container.descriptor.anchorMessageId,
          parentThreadId: container.descriptor.parentThreadId,
          runRef: null,
          title: null,
          createdAt: new Date(0),
        });
      case "delivery":
        return threadForDescriptor(tenantId, workbenchId, container.threadId, {
          parentMessageId: null,
          parentThreadId: null,
          runRef: container.descriptor.runRef,
          title: null,
          createdAt: new Date(0),
        });
    }
  }

  return {
    async ensureRootThread(tenantId, workbenchId) {
      return threadForDescriptor(tenantId, workbenchId, rootThreadId(workbenchId), {
        parentMessageId: null,
        parentThreadId: null,
        runRef: null,
        title: null,
        createdAt: new Date(0),
      });
    },

    async createDeliveryThread(input: CreateDeliveryThreadInput) {
      // Pure: the descriptor IS the thread, and the title rides the
      // delivery ref the send stamps — `getThread` reunites them.
      return threadForDescriptor(
        input.tenantId,
        input.workbenchId,
        deliveryThreadId(input.runRef),
        {
          parentMessageId: null,
          parentThreadId: null,
          runRef: input.runRef,
          title: input.title ?? null,
          createdAt: new Date(),
        },
      );
    },

    async openReplyThread(input: OpenReplyThreadInput) {
      const container = await containerOfMessage(
        input.tenantId,
        input.workbenchId,
        input.parentMessageId,
      );
      const anchor = resolveThreadAnchor(
        await this.ensureRootThread(input.tenantId, input.workbenchId),
        containerThread(input.tenantId, input.workbenchId, container),
      );
      if (anchor.blocked) throw new ThreadDepthCapError();
      if (anchor.parentThreadId === rootThreadId(input.workbenchId)) {
        return threadForDescriptor(
          input.tenantId,
          input.workbenchId,
          replyThreadId(input.parentMessageId),
          {
            parentMessageId: input.parentMessageId,
            parentThreadId: anchor.parentThreadId,
            runRef: null,
            title: input.title ?? null,
            createdAt: new Date(),
          },
        );
      }
      return threadForDescriptor(
        input.tenantId,
        input.workbenchId,
        subThreadId(anchor.parentThreadId, input.parentMessageId),
        {
          parentMessageId: input.parentMessageId,
          parentThreadId: anchor.parentThreadId,
          runRef: null,
          title: input.title ?? null,
          createdAt: new Date(),
        },
      );
    },

    async forkThread(input: ForkThreadInput) {
      const container = await containerOfMessage(
        input.tenantId,
        input.workbenchId,
        input.parentMessageId,
      );
      const anchor = resolveThreadAnchor(
        await this.ensureRootThread(input.tenantId, input.workbenchId),
        containerThread(input.tenantId, input.workbenchId, container),
      );
      // A fork never refuses: off a depth-2 thread it redirects to a
      // sibling under that thread's parent — the CL-5948 rule, now
      // structural rather than row-read.
      const parentThreadId = anchor.parentThreadId;
      if (parentThreadId === rootThreadId(input.workbenchId)) {
        return threadForDescriptor(
          input.tenantId,
          input.workbenchId,
          replyThreadId(input.parentMessageId),
          {
            parentMessageId: input.parentMessageId,
            parentThreadId,
            runRef: null,
            title: input.title ?? null,
            createdAt: new Date(),
          },
        );
      }
      return threadForDescriptor(
        input.tenantId,
        input.workbenchId,
        subThreadId(parentThreadId, input.parentMessageId),
        {
          parentMessageId: input.parentMessageId,
          parentThreadId,
          runRef: null,
          title: input.title ?? null,
          createdAt: new Date(),
        },
      );
    },

    async getThread(tenantId, workbenchId, threadId, principalId?) {
      const descriptor = parseThreadDescriptor(threadId);
      if (descriptor === undefined) return undefined;
      switch (descriptor.kind) {
        case "root":
          if (descriptor.workbenchId !== workbenchId) return undefined;
          return threadForDescriptor(tenantId, workbenchId, threadId, {
            parentMessageId: null,
            parentThreadId: null,
            runRef: null,
            title: null,
            createdAt: new Date(0),
          });
        case "reply":
          return threadForDescriptor(tenantId, workbenchId, threadId, {
            parentMessageId: descriptor.parentMessageId,
            parentThreadId: rootThreadId(workbenchId),
            runRef: null,
            title: null,
            createdAt: new Date(0),
          });
        case "sub":
          return threadForDescriptor(tenantId, workbenchId, threadId, {
            parentMessageId: descriptor.anchorMessageId,
            parentThreadId: descriptor.parentThreadId,
            runRef: null,
            title: null,
            createdAt: new Date(0),
          });
        case "delivery": {
          // The title lives on the frames, not the descriptor: find the
          // frame carrying this delivery ref in the reader's own copies.
          // Ancestry-only callers omit the reader and get the structure
          // with a null title — dispatch needs the run ref, never the
          // display title.
          if (principalId === undefined) {
            return threadForDescriptor(tenantId, workbenchId, threadId, {
              parentMessageId: null,
              parentThreadId: null,
              runRef: descriptor.runRef,
              title: null,
              createdAt: new Date(0),
            });
          }
          const headers = await deps.listWorkbenchFrameHeaders(
            tenantId,
            principalId,
            workbenchId,
          );
          const carrying = headers.find(
            (header) => header.deliveryRef?.id === descriptor.runRef,
          );
          return threadForDescriptor(tenantId, workbenchId, threadId, {
            parentMessageId: null,
            parentThreadId: null,
            runRef: descriptor.runRef,
            title: carrying?.deliveryRef?.label ?? null,
            createdAt:
              carrying !== undefined ? new Date(carrying.date) : new Date(0),
          });
        }
      }
    },

    async listThreads(tenantId, workbenchId, principalId) {
      const headers = await deps.listWorkbenchFrameHeaders(
        tenantId,
        principalId,
        workbenchId,
      );
      const byThread = new Map<string, NativeFrameHeaders[]>();
      const derived = deriveThreadIds(headers, workbenchId);
      for (const header of headers) {
        const threadId = derived.get(header.msgId);
        if (threadId === undefined) continue;
        const group = byThread.get(threadId);
        if (group === undefined) byThread.set(threadId, [header]);
        else group.push(header);
      }
      const threads: WorkbenchThread[] = [
        await this.ensureRootThread(tenantId, workbenchId),
      ];
      for (const [threadId, group] of byThread) {
        if (threadId === rootThreadId(workbenchId)) continue;
        const descriptor = parseThreadDescriptor(threadId);
        if (descriptor === undefined) continue;
        const [first] = group;
        const createdAt =
          first !== undefined ? new Date(first.date) : new Date(0);
        if (descriptor.kind === "reply") {
          threads.push(
            threadForDescriptor(tenantId, workbenchId, threadId, {
              parentMessageId: descriptor.parentMessageId,
              parentThreadId: rootThreadId(workbenchId),
              runRef: null,
              title: null,
              createdAt,
            }),
          );
        } else if (descriptor.kind === "sub") {
          threads.push(
            threadForDescriptor(tenantId, workbenchId, threadId, {
              parentMessageId: descriptor.anchorMessageId,
              parentThreadId: descriptor.parentThreadId,
              runRef: null,
              title: null,
              createdAt,
            }),
          );
        } else if (descriptor.kind === "delivery") {
          const carrying = group.find(
            (header) => header.deliveryRef?.id === descriptor.runRef,
          );
          threads.push(
            threadForDescriptor(tenantId, workbenchId, threadId, {
              parentMessageId: null,
              parentThreadId: null,
              runRef: descriptor.runRef,
              title: carrying?.deliveryRef?.label ?? null,
              createdAt,
            }),
          );
        }
      }
      return threads;
    },

    async listMessageIds(tenantId, workbenchId, threadId, principalId) {
      const headers = await deps.listWorkbenchFrameHeaders(
        tenantId,
        principalId,
        workbenchId,
      );
      const derived = deriveThreadIds(headers, workbenchId);
      return headers
        .filter((header) => derived.get(header.msgId) === threadId)
        .map((header) => header.msgId);
    },

    async listThreadAssignments(tenantId, workbenchId, principalId) {
      const headers = await deps.listWorkbenchFrameHeaders(
        tenantId,
        principalId,
        workbenchId,
      );
      return deriveThreadIds(headers, workbenchId);
    },

    async threadIdForMessage(tenantId, workbenchId, messageId) {
      const found = await headersFor(tenantId, [messageId]);
      const header = found.get(messageId);
      if (header === undefined || header.workbenchId !== workbenchId) {
        return undefined;
      }
      if (
        header.threadRef !== undefined ||
        header.deliveryRef !== undefined ||
        parentMsgIdOf(header) === undefined
      ) {
        return deriveThreadId(header, new Map([[messageId, header]]), workbenchId);
      }
      // Walk at most two ancestors up — the same bound the store's
      // container check uses, and exact for every send-time shape.
      const byMsgId = new Map([[messageId, header]]);
      let frontier = [header];
      for (let round = 0; round < 2; round += 1) {
        const wanted = frontier
          .map((entry) => parentMsgIdOf(entry))
          .filter(
            (parent): parent is string =>
              parent !== undefined && !byMsgId.has(parent),
          );
        if (wanted.length === 0) break;
        const more = await headersFor(tenantId, wanted);
        let grew = false;
        for (const [id, next] of more) {
          if (!byMsgId.has(id)) {
            byMsgId.set(id, next);
            grew = true;
          }
        }
        frontier = [...more.values()];
        if (!grew) break;
      }
      return deriveThreadId(header, byMsgId, workbenchId);
    },
  };
}
