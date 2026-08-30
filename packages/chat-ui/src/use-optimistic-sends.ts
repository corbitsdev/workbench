// This composer's own optimistic sends.
//
// A submit shows up in the timeline immediately rather than waiting on the
// round-trip, and the confirmed message replaces that pending bubble in the
// very same state update — there is never a render where the message has
// vanished from both while a fresh read is still in flight, and never one
// where the pending and confirmed copies both show.
//
// The pending bubble's nonce doubles as its wire `clientId`: the server
// echoes it back and records it, so the next `GET .../messages` page
// carries it too. `mergePendingSends` drops the pending entry the moment
// either arrival shows up with a matching `clientId`, so whichever wins
// that race, the other is a no-op.

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChatApiError, pingWorkbenchPresence, sendMessage } from "./api";
import type { MessageItem, MessagesResponse } from "./api";
import { partsForSend } from "./composer";
import type { ComposerAttachment, ComposerSendPayload } from "./composer";
import type { MentionInviteIntent } from "./mentions";
import { CHAT_STRINGS } from "./strings";
import type { PendingMessageStatus, TimelineMessageItem } from "./timeline";
import { toast } from "@corbits/react-ui";
import {
  chatMessagesQueryKey,
  chatThreadsQueryKey,
  ensureReplyThreadRow,
  type ThreadsQueryData,
} from "./use-workbench-feed";

export type PendingSend = {
  readonly nonce: string;
  readonly text: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly createdAt: string;
  readonly status: PendingMessageStatus;
  /** The "Bring in…" picks this submit carried — kept on the pending
   * entry so a Retry re-runs the same pre-invite step the original
   * submit did. */
  readonly invite?: readonly MentionInviteIntent[];
};

let pendingSendSeq = 0;

/** A fresh client-side nonce for one composer submit — exported so tests
 * can reset the counter between cases without reaching into module
 * internals. */
export function resetPendingSendNonceForTests(): void {
  pendingSendSeq = 0;
}

/** Random per-page-load prefix: a pending nonce doubles as the message's
 * wire `clientId` (CL-6251), which the server persists — a bare counter
 * would repeat `pending_1` on every reload, colliding with a prior
 * session's stored clientId in the same workbench (wrong-message matches
 * in `mergePendingSends`, duplicate React keys in `WorkbenchTimeline`). */
const pendingSendSession = Math.random().toString(36).slice(2, 10);

function nextPendingSendNonce(): string {
  pendingSendSeq += 1;
  return `pending_${pendingSendSession}_${pendingSendSeq}`;
}

/** The sender address a pending send's synthetic item renders under —
 * `senderDisplay` (`timeline.tsx`) matches its local part against
 * `currentUser.principalId` to render "You" regardless of domain, so the
 * `@pending.local` half is never load-bearing, only honest about the
 * item not being server-issued yet. Shared with `sendPending`'s own
 * synchronous insert (`chat-workspace.tsx`) so a message never changes
 * sender identity mid-flight. */
export function pendingSenderAddress(
  currentUserPrincipalId: string | undefined,
): string {
  return `${currentUserPrincipalId ?? "you"}@pending.local`;
}

/**
 * Folds this workspace's own still-in-flight sends onto the end of the
 * server's message list, oldest-first like the rest of the timeline —
 * one message list, rendered through the exact same path as any
 * confirmed message (`WorkbenchTimeline`'s `MessageParts`), never a
 * separate visually-distinct tier. `pendingStatus`/`pendingNonce` are
 * the only markers that distinguish it: a small "sending" clock glyph,
 * or (once failed) an inline retry row — see `TimelineMessageItem`.
 *
 * A pending send's `nonce` doubles as the `clientId` it sent on the wire
 * (see `sendPending`) and is carried onto the synthetic item's own
 * `clientId` too, so it keys identically to whichever confirmed message
 * later reconciles it — `WorkbenchTimeline` renders both under the same
 * React key, updating one DOM node in place rather than unmounting a
 * pending bubble and mounting an unrelated confirmed one.
 *
 * Once `items` contains a confirmed message carrying that same
 * `clientId` (from the POST response landing, or from a later `GET
 * .../messages` page — whichever arrives first), the pending entry is
 * identity-matched and dropped here rather than rendered alongside its
 * own confirmed copy. This is never a heuristic guess from
 * content/timing; a message with no `clientId` at all (sent before this
 * feature, or by a peer) never matches any pending entry.
 */
export function mergePendingSends(
  items: readonly MessageItem[],
  pendingSends: readonly PendingSend[],
  currentUserPrincipalId: string | undefined,
): readonly TimelineMessageItem[] {
  if (pendingSends.length === 0) return items;
  const confirmedClientIds = new Set(
    items
      .map((item) => item.clientId)
      .filter((clientId): clientId is string => clientId !== undefined),
  );
  const unresolvedSends = pendingSends.filter(
    (pending) => !confirmedClientIds.has(pending.nonce),
  );
  if (unresolvedSends.length === 0) return items;
  const senderAddress = pendingSenderAddress(currentUserPrincipalId);
  const pendingItems: TimelineMessageItem[] = unresolvedSends.map(
    (pending) => ({
      id: pending.nonce,
      createdAt: pending.createdAt,
      parts: partsForSend(pending.text, pending.attachments),
      sender: { name: null, address: senderAddress },
      clientId: pending.nonce,
      pendingStatus: pending.status,
      pendingNonce: pending.nonce,
    }),
  );
  return [...items, ...pendingItems];
}

export interface OptimisticSends {
  readonly pendingSends: readonly PendingSend[];
  readonly handleSend: (payload: ComposerSendPayload) => Promise<boolean>;
  readonly retryPendingSend: (nonce: string) => void;
  readonly discardPendingSend: (nonce: string) => void;
}

export function useOptimisticSends(args: {
  readonly tenantId: string;
  readonly activeWorkbenchId: string | null;
  readonly currentUserPrincipalId: string | undefined;
  readonly openThreadId: string | null;
  readonly pendingParentMessageId: string | null;
  readonly openThreadById: (threadId: string) => void;
  /** Fires once a send lands in a workbench that has an agent in it: a
   * reply is owed, so the typing indicator shows now rather than sitting
   * silent until the turn's first stream event arrives. */
  readonly noteAwaitingReply: () => void;
  readonly hasAgentParticipant: boolean;
  /** Hands recovered text back to the composer's draft — the only door it
   * comes back through, since a submit always clears the box on the way out. */
  readonly restoreDraft: (text: string) => void;
}): OptimisticSends {
  const {
    tenantId,
    activeWorkbenchId,
    currentUserPrincipalId,
    openThreadId,
    pendingParentMessageId,
    openThreadById,
    noteAwaitingReply,
    hasAgentParticipant,
    restoreDraft,
  } = args;
  const queryClient = useQueryClient();
  const [pendingSends, setPendingSends] = useState<readonly PendingSend[]>([]);

  // Switching workbenches drops whatever was pending in the previous one:
  // that submit targeted that workbench, not wherever the reader went next.
  useEffect(() => {
    setPendingSends([]);
  }, [activeWorkbenchId]);

  // `sendPending` closes over the `activeWorkbenchId` its own render was
  // called with, which stays fixed for the life of that async call. This
  // ref tracks the live value so a continuation resolving after the reader
  // has switched benches can tell its own send is no longer for the
  // workbench currently on screen (CL-7198).
  const activeWorkbenchIdRef = useRef(activeWorkbenchId);
  useEffect(() => {
    activeWorkbenchIdRef.current = activeWorkbenchId;
  }, [activeWorkbenchId]);

  async function sendPending(
    nonce: string,
    text: string,
    attachments: readonly ComposerAttachment[],
    invite?: readonly MentionInviteIntent[],
  ): Promise<void> {
    if (activeWorkbenchId === null) return;
    const parts = partsForSend(text, attachments);
    if (parts.length === 0) return;
    const inviteOption = invite !== undefined ? { invite } : {};
    // The pending bubble's own nonce doubles as its wire `clientId` —
    // no second id needed. The server echoes it back below and, once
    // wired, records it against the message so the next `GET
    // .../messages` page carries it too; `mergePendingSends` drops
    // this pending entry the moment either arrival shows up with a
    // matching `clientId`, so whichever wins this race, the other is
    // a no-op.
    try {
      let sent: {
        readonly id: string;
        readonly createdAt: string;
        readonly threadId?: string;
        readonly clientId?: string;
      };
      if (openThreadId !== null) {
        sent = await sendMessage(tenantId, activeWorkbenchId, parts, {
          threadId: openThreadId,
          clientId: nonce,
          ...inviteOption,
        });
      } else if (pendingParentMessageId !== null) {
        sent = await sendMessage(tenantId, activeWorkbenchId, parts, {
          inReplyToMessageId: pendingParentMessageId,
          clientId: nonce,
          ...inviteOption,
        });
      } else {
        sent = await sendMessage(tenantId, activeWorkbenchId, parts, {
          clientId: nonce,
          ...inviteOption,
        });
      }
      const confirmed: MessageItem = {
        id: sent.id,
        createdAt: sent.createdAt,
        parts,
        sender: {
          name: null,
          address: pendingSenderAddress(currentUserPrincipalId),
        },
        clientId: sent.clientId ?? nonce,
        // Stamp the server-assigned thread so the confirmed row scopes into
        // the reply feed immediately (CL-6660). The stream echo may still
        // arrive without threadId when assignment raced publish; keeping
        // this stamp means that echo's dedupe path is a no-op rather than
        // leaving the message stuck on the root feed.
        ...(sent.threadId !== undefined ? { threadId: sent.threadId } : {}),
      };
      // A refresh already in flight was issued before this send and will
      // report a mailbox without it — letting it resolve into the cache
      // would blink the just-sent message back out. Cancelling first is
      // what makes the write below the last word on this key.
      await queryClient.cancelQueries({
        queryKey: chatMessagesQueryKey(tenantId, activeWorkbenchId),
      });
      // Written straight into the cache so the confirmed message replaces
      // the pending bubble in the same render — there is never a frame
      // where it has vanished from both while a refetch is still in
      // flight. A refresh may have folded it in already (refresh-first
      // interleaving); appending unconditionally would render it twice
      // under one key. When the row is already present but still lacks
      // `threadId`, patch it in place so a racing stream echo without a
      // thread cannot leave the confirm stranded on the root feed.
      queryClient.setQueryData(
        chatMessagesQueryKey(tenantId, activeWorkbenchId),
        (current: MessagesResponse | undefined) => {
          if (current === undefined) return current;
          const matchIndex = current.items.findIndex(
            (item) =>
              item.id === confirmed.id || item.clientId === confirmed.clientId,
          );
          if (matchIndex >= 0) {
            const existing = current.items[matchIndex];
            if (existing === undefined) return current;
            if (
              confirmed.threadId !== undefined &&
              existing.threadId !== confirmed.threadId
            ) {
              const items = current.items.slice();
              items[matchIndex] = {
                ...existing,
                threadId: confirmed.threadId,
              };
              return { ...current, items };
            }
            return current;
          }
          return { ...current, items: [...current.items, confirmed] };
        },
      );
      // Seed / bump the threads cache before navigation opens the just-
      // created id (CL-6660). Without the row, `useThreadNavigation`'s
      // stale-id effect would drop `openThreadId` the moment it was set.
      if (sent.threadId !== undefined) {
        const threadId = sent.threadId;
        const parentMessageId = pendingParentMessageId;
        queryClient.setQueryData(
          chatThreadsQueryKey(tenantId, activeWorkbenchId),
          (current: ThreadsQueryData | undefined) => {
            if (current === undefined) return current;
            return ensureReplyThreadRow(current, {
              threadId,
              createdAt: sent.createdAt,
              ...(parentMessageId !== null ? { parentMessageId } : {}),
              bumpReplyCount: true,
            });
          },
        );
        // A continuation that started before the reader switched to a
        // different workbench must not drag them back into this one's
        // thread — `useThreadNavigation` already reset the open thread on
        // that switch; re-opening it here would undo that reset (CL-7198).
        if (
          pendingParentMessageId !== null &&
          activeWorkbenchIdRef.current === activeWorkbenchId
        ) {
          openThreadById(threadId);
        }
      }
      setPendingSends((current) => current.filter((p) => p.nonce !== nonce));
      // A message just landed in a workbench with an agent in it: a reply
      // is owed, so show the typing indicator now rather than sitting
      // silent until the turn's first stream event arrives.
      if (hasAgentParticipant) noteAwaitingReply();
      // No follow-up GET (CL-6328): the confirmed row is already written
      // above, and this workbench's own `chat.message` echo (dedup'd by
      // `clientId`/`id` in `applyStreamMessage`) is what every *other*
      // connection learns the send from. Sending is real activity, so it
      // doubles as this connection's presence ping.
      void pingWorkbenchPresence(tenantId, activeWorkbenchId);
    } catch (cause) {
      if (cause instanceof ChatApiError && cause.status === 403) {
        toast(CHAT_STRINGS.mentionForbidden);
      }
      setPendingSends((current) =>
        current.map((p) =>
          p.nonce === nonce ? { ...p, status: "failed" } : p,
        ),
      );
    }
  }

  async function handleSend(payload: ComposerSendPayload): Promise<boolean> {
    if (activeWorkbenchId === null) return false;
    const parts = partsForSend(payload.text, payload.attachments);
    if (parts.length === 0) return false;
    const nonce = nextPendingSendNonce();
    setPendingSends((current) => [
      ...current,
      {
        nonce,
        text: payload.text,
        attachments: payload.attachments,
        createdAt: new Date().toISOString(),
        status: "sending",
        ...(payload.invite !== undefined ? { invite: payload.invite } : {}),
      },
    ]);
    await sendPending(nonce, payload.text, payload.attachments, payload.invite);
    return true;
  }

  function retryPendingSend(nonce: string) {
    const pending = pendingSends.find((p) => p.nonce === nonce);
    if (pending === undefined) return;
    setPendingSends((current) =>
      current.map((p) => (p.nonce === nonce ? { ...p, status: "sending" } : p)),
    );
    void sendPending(nonce, pending.text, pending.attachments, pending.invite);
  }

  /** Drops the failed pending bubble and hands its text back to the
   * composer's draft — the only door recovered text comes back through,
   * since a submit always clears the box on the way out. */
  function discardPendingSend(nonce: string) {
    const pending = pendingSends.find((p) => p.nonce === nonce);
    if (pending === undefined) return;
    setPendingSends((current) => current.filter((p) => p.nonce !== nonce));
    if (pending.text.length > 0) {
      restoreDraft(pending.text);
    }
  }

  return { pendingSends, handleSend, retryPendingSend, discardPendingSend };
}
