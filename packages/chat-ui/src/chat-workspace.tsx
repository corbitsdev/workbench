// Chat workspace: the host resolves which bench the signed-in
// account chats in, loads its channels and deployed agents, and wires the
// timeline and composer together for whichever channel is
// selected. Channel list lives in the shell contextual panel — this
// surface is the active conversation only.
//
// Resolving *which* bench that is is host-specific (it rides on
// whatever session/query plumbing the embedding app already has — in
// `@workbench/web` that is the same `/api/me/principals` call the Home
// and Settings pages use), so `ChatWorkspace` takes a small
// `TenantResolution` value rather than importing app code: the same
// narrow-port shape `@corbits/chat`'s `routes.ts` uses for `ChatPlatform`.

import { isAgentAddress } from "@corbits/chat/mentions";
import { Button, EmptyState, Skeleton, toast } from "@corbits/react-ui";
import {
  ChartColumn,
  ChevronDown,
  CircleAlert,
  MessageSquare,
  Repeat,
  SlidersHorizontal,
  UserPlus,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  ChatApiError,
  channelsQueryKey,
  channelsQueryKeyPrefix,
  createChannel,
  describeChatError,
  forkThread,
  inviteAgent,
  listChannels,
  listMessages,
  listPinnedMessages,
  listThreadMessages,
  listThreads,
  patchChannelSettings,
  pinMessage,
  putReadState,
  sendMessage,
  toggleReaction,
  unpinMessage,
  channelStreamUrl,
  isKnownChannelKind,
} from "./api";
import type {
  Channel,
  ChannelThread,
  CreateChannelInput,
  MessageItem,
  Part,
  PinnedMessage,
} from "./api";
import { ChannelSettingsSurface } from "./channel-settings";
import type { ChannelSettingsSectionId } from "./channel-settings";
import { Composer, partsForSend } from "./composer";
import type {
  ComposerAttachment,
  ComposerHandle,
  ComposerSendPayload,
} from "./composer";
import { InviteAgentDialog } from "./invite-agent-dialog";
import { mentionCandidatesFromParticipants } from "./mentions";
import { NewChannelDialog } from "./new-channel-dialog";
import type { PersonOption } from "./new-channel-dialog";
import { PinnedStrip } from "./pinned-strip";
import { CHAT_STRINGS } from "./strings";
import { AgentBadge, ChannelTimeline, messageDomId } from "./timeline";
import type {
  CurrentUser,
  PendingMessageStatus,
  PinActions,
  ReactionActions,
  ThreadAffordanceMeta,
  TimelineMessageItem,
} from "./timeline";
import type { ApprovalActions } from "./blocks/approval-actions";
import type { BlockResponseActions } from "./blocks/block-responses";
import {
  typingLabel,
  TypingIndicator,
  useTypingIndicator,
} from "./typing-indicator";
import type { ProfileSubject } from "./profile-subject";
import { useChannelStream } from "./use-channel-stream";

/**
 * The host's answer to "which bench does this account chat in": mirrors
 * the loading/unauthenticated/error/ready shape every hub-backed query
 * in the embedding app already uses, plus `"empty"` for an
 * authenticated account with no bench membership at all.
 */
export type TenantResolution =
  | { readonly kind: "loading" }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly tenantId: string };

/**
 * One live presence entry for the channel's who's-here stack — deliberately
 * a plain data shape, not `@corbits/presence`'s own type: this package
 * never depends on presence, the same way it never depends on any other
 * domain package it's merely handed data from. The host composes the real
 * connection (`@corbits/presence/client`) and passes the current snapshot
 * down as `presenceMembers`.
 */
export interface PresenceMember {
  readonly principalId: string;
  readonly displayName: string;
  readonly color: string;
}

type ChannelsState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly channels: readonly Channel[];
      readonly chats: readonly Channel[];
    };

export type MessagesState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "error";
      readonly message: string;
      /** The channel itself 404s, not just this load — retrying with the
       * same id can never succeed, so the UI trades "Try again" for an
       * honest way out instead. */
      readonly channelNotFound: boolean;
    }
  | { readonly kind: "ready"; readonly items: readonly MessageItem[] };

export type MessagesLoadOutcome =
  | { readonly kind: "success"; readonly items: readonly MessageItem[] }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly channelNotFound: boolean;
    };

/**
 * A background refresh (SSE/poll) never shows the loading skeleton and
 * never replaces a `ready` timeline with an error page — it only ever moves
 * `ready` state forward on success, and otherwise leaves whatever was on
 * screen untouched. A foreground load (first load or channel switch)
 * always reflects the outcome directly.
 */
export function nextMessagesState(
  current: MessagesState,
  outcome: MessagesLoadOutcome,
  background: boolean,
): MessagesState {
  if (outcome.kind === "success") {
    return { kind: "ready", items: outcome.items };
  }
  if (background) return current;
  return {
    kind: "error",
    message: outcome.message,
    channelNotFound: outcome.channelNotFound,
  };
}

/**
 * A chat's agent is fixed at creation — the server 409s an invite into one
 * — so the "invite agent" affordance only ever makes sense on a channel or
 * on a kind this UI doesn't otherwise recognize. Undefined (no channel
 * resolved yet) defaults to showing it.
 */
export function canInviteAgent(kind: string | undefined): boolean {
  if (kind === undefined) return true;
  return !isKnownChannelKind(kind) || kind !== "chat";
}

/**
 * The composer's placeholder reads as a direct message once the active
 * surface is a chat, naming its one counterpart — a chat's title always
 * defaults to that counterpart's name at creation (see `routes.ts`'s
 * `POST /channels`), so it's always the right word here even when the
 * counterpart is a person, not an agent. A channel (or a surface that
 * hasn't resolved yet) keeps the generic, mention-driven copy.
 */
export function composerPlaceholderFor(
  channel:
    | {
        readonly kind: string;
        readonly title: string;
      }
    | undefined,
): string {
  if (channel === undefined || channel.kind !== "chat") {
    return CHAT_STRINGS.composerPlaceholder;
  }
  const counterpart =
    channel.title.trim().length > 0
      ? channel.title
      : CHAT_STRINGS.unnamedChannel;
  return CHAT_STRINGS.composerPlaceholderChat(counterpart);
}

/**
 * Which message source the timeline should load for the current view.
 *
 * - Open reply/delivery thread → that thread's membership only
 * - Brand-new reply (pending parent, no thread yet) → empty
 * - Channel root feed → the channel's root thread only (never full channel
 *   mail, which mixes reply-thread messages into the root timeline)
 * - Threads API unavailable (empty rootThreadId) → full mailbox fallback
 */
export type MessageFeedTarget =
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "empty" }
  | { readonly kind: "root-thread"; readonly rootThreadId: string }
  | { readonly kind: "channel-mail" };

export function resolveMessageFeedTarget(args: {
  readonly openThreadId: string | null;
  readonly pendingParentMessageId: string | null;
  readonly rootThreadId: string | null;
}): MessageFeedTarget {
  if (args.openThreadId !== null) {
    return { kind: "thread", threadId: args.openThreadId };
  }
  if (args.pendingParentMessageId !== null) {
    return { kind: "empty" };
  }
  if (args.rootThreadId !== null && args.rootThreadId !== "") {
    return { kind: "root-thread", rootThreadId: args.rootThreadId };
  }
  return { kind: "channel-mail" };
}

function sortMessagesOldestFirst(items: readonly MessageItem[]): MessageItem[] {
  return [...items].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id.localeCompare(b.id)
      : a.createdAt.localeCompare(b.createdAt),
  );
}

/**
 * A composer submit this workspace has optimistically added to the
 * timeline before the server confirms it — see `TimelineMessageItem`'s
 * `pendingStatus`. `nonce` is this workspace's own client-side key,
 * independent of any server-issued message id (which does not exist yet
 * while `status` is `"sending"`, and never will if it ends up discarded).
 */
export type PendingSend = {
  readonly nonce: string;
  readonly text: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly createdAt: string;
  readonly status: PendingMessageStatus;
};

let pendingSendSeq = 0;

/** A fresh client-side nonce for one composer submit — exported so tests
 * can reset the counter between cases without reaching into module
 * internals. */
export function resetPendingSendNonceForTests(): void {
  pendingSendSeq = 0;
}

function nextPendingSendNonce(): string {
  pendingSendSeq += 1;
  return `pending_${pendingSendSeq}`;
}

/**
 * Folds this workspace's own optimistic sends onto the end of the
 * server's message list, oldest-first like the rest of the timeline — a
 * pending send is definitionally newer than anything the server has
 * confirmed for this composer submit. Rendered as `TimelineMessageItem`s
 * carrying no `reactions`/`pinned` (a pending entry has neither yet) and
 * a sender built from the signed-in principal, the same address shape
 * `senderDisplay` already matches against `currentUser.principalId` to
 * render "You".
 */
export function mergePendingSends(
  items: readonly MessageItem[],
  pendingSends: readonly PendingSend[],
  currentUserPrincipalId: string | undefined,
): readonly TimelineMessageItem[] {
  if (pendingSends.length === 0) return items;
  const senderAddress = `${currentUserPrincipalId ?? "you"}@pending.local`;
  const pendingItems: TimelineMessageItem[] = pendingSends.map((pending) => ({
    id: pending.nonce,
    createdAt: pending.createdAt,
    parts: partsForSend(pending.text, pending.attachments),
    sender: { name: null, address: senderAddress },
    pendingStatus: pending.status,
    pendingNonce: pending.nonce,
  }));
  return [...items, ...pendingItems];
}

/**
 * Channels and chats via TanStack Query, keyed with `channelsQueryKey` —
 * the same key `apps/web`'s shell bands and command palette use, so this
 * sidebar shares one in-flight fetch per (tenantId, kind) with the rest of
 * the shell rather than firing its own independent request on every mount.
 */
function useChannelLists(tenantId: string) {
  const channels = useQuery({
    queryKey: channelsQueryKey(tenantId, "channel"),
    queryFn: () => listChannels(tenantId, "channel"),
  });
  const chats = useQuery({
    queryKey: channelsQueryKey(tenantId, "chat"),
    queryFn: () => listChannels(tenantId, "chat"),
  });

  const reload = useCallback(async () => {
    await Promise.all([channels.refetch(), chats.refetch()]);
  }, [channels.refetch, chats.refetch]);

  // Referentially stable across renders that don't actually change the
  // underlying data — a fresh object literal here every render would make
  // `channelsState` look "changed" to every effect that depends on it
  // (the auto-select-first-channel effect below included), firing them on
  // every unrelated re-render rather than only when channels/chats data
  // itself moves.
  const state: ChannelsState = useMemo(() => {
    if (channels.isError) {
      return {
        kind: "error",
        message: describeChatError(
          channels.error,
          "Couldn't load workbenches.",
        ),
      };
    }
    if (chats.isError) {
      return {
        kind: "error",
        message: describeChatError(chats.error, "Couldn't load workbenches."),
      };
    }
    if (channels.data === undefined || chats.data === undefined) {
      return { kind: "loading" };
    }
    return { kind: "ready", channels: channels.data, chats: chats.data };
  }, [
    channels.isError,
    channels.error,
    channels.data,
    chats.isError,
    chats.error,
    chats.data,
  ]);

  return { state, reload };
}

function ChatWorkspaceInner({
  tenantId,
  channelId: controlledChannelId,
  onChannelChange,
  currentUser,
  onOpenProfile,
  settingsOpen = false,
  onSettingsOpenChange,
  settingsSection = "general",
  onSettingsSectionChange,
  onOpenArtifact,
  onOpenArtifactInLibrary,
  onFixConnection,
  approvalActions,
  blockResponses,
  headerLeading,
  listMembers,
  registerComposerInsert,
  onOpenRoutines,
  onRequestNewAgent,
  onCreateRoutineInSpace,
  onOpenInsights,
  presenceMembers,
  onChannelNotFound,
  onBackToChannelList,
}: {
  readonly tenantId: string;
  readonly channelId?: string | null;
  readonly onChannelChange?: (channelId: string) => void;
  readonly currentUser?: CurrentUser;
  readonly onOpenProfile?: (subject: ProfileSubject) => void;
  /** Whether the routed channel's settings surface should replace the
   * conversation stage (mock § Channel settings — a full surface, never a
   * dialog). Host-controlled the same way `channelId` is: driven from the
   * URL (`/c/:id/settings`). */
  readonly settingsOpen?: boolean;
  /** Fired when the settings surface should open or close. `section` is
   * only passed on open — the section the opener meant to land on (the
   * gear button's General, or the composer's `/agents` shortcut) — so the
   * host can navigate straight to that URL without a second, separate
   * navigation for the section. */
  readonly onSettingsOpenChange?: (
    open: boolean,
    section?: ChannelSettingsSectionId,
  ) => void;
  /** Which channel settings tab is active while the surface is open —
   * host-controlled the same way `settingsOpen` is, driven from the URL
   * (`/c/:id/settings/:section`). */
  readonly settingsSection?: ChannelSettingsSectionId;
  /** Fired when the user switches tabs while the settings surface is
   * already open, so the host can reflect it in the URL. */
  readonly onSettingsSectionChange?: (
    section: ChannelSettingsSectionId,
  ) => void;
  readonly onOpenArtifact?: (part: Part & { kind: "file" }) => void;
  readonly onOpenArtifactInLibrary?: (part: Part & { kind: "file" }) => void;
  /** See `ChannelTimeline`'s `onFixConnection` (CL-6092). */
  readonly onFixConnection?: () => void;
  readonly approvalActions?: ApprovalActions;
  readonly blockResponses?: BlockResponseActions;
  readonly headerLeading?: ReactNode;
  /** The bench's people, for the new-chat dialog's People tab — see
   * `NewChannelDialog`'s own prop note. Host-supplied, the same way
   * `currentUser`/`tenant` are. */
  readonly listMembers?: (tenantId: string) => Promise<readonly PersonOption[]>;
  /**
   * Hands the host a function that inserts text into the active channel's
   * composer, or `null` while no composer is mounted (loading/error states,
   * settings surface). The profile card's Mention action (CL-5914) is the
   * first caller — a shell-level seam, so the host stores the latest
   * function rather than this component reaching outside its own tree.
   */
  readonly registerComposerInsert?: (
    insert: ((text: string) => void) | null,
  ) => void;
  /** The composer's `/run` command: routine create/run lives on its own
   * route the host owns, so opening it is a host-supplied hop the same way
   * `onOpenArtifact` is. */
  readonly onOpenRoutines?: () => void;
  /**
   * The new-chat picker's "New agent…" affordance, beneath its agent
   * list — omitted entirely, the row doesn't render (same contract as
   * `listMembers`). Firing this closes this component's own
   * `NewChannelDialog` first, then delegates to the host, which owns
   * the actual create-agent panel (an apps/web page component this
   * package never depends on).
   */
  readonly onRequestNewAgent?: () => void;

  /**
   * "New routine in this space" — the header button and the composer's
   * `/routine` command: opens the New Routine panel with the active
   * channel pre-bound as its destination. Host-supplied so the panel's
   * own route (and its prefill store) stays owned by the host, the same
   * way `onOpenRoutines` is; the active channel id is closed over here
   * rather than passed as an argument, since only this component knows
   * it. Omitted, the button and command are hidden — the same
   * "no dead promise" contract `onOpenRoutines` follows.
   */
  readonly onCreateRoutineInSpace?: (channelId: string) => void;
  /**
   * "Insights for this workbench" — the header button that deep-links to
   * this tenant's own Insights scope (CL-6099). Host-supplied so the
   * Insights route (and its tenant-scope resolution) stays owned by the
   * host, the same way `onOpenRoutines` is. Omitted, the button is
   * hidden — the same "no dead promise" contract as the other optional
   * header actions here.
   */
  readonly onOpenInsights?: () => void;
  /** See `ChatWorkspace`'s prop of the same name. */
  readonly presenceMembers?: readonly PresenceMember[];
  /** Fired when the routed channel 404s — a deleted channel, or a stale
   * Recents entry that outlived it. The host owns Recents (this package
   * never touches localStorage), so it's told rather than reaching out. */
  readonly onChannelNotFound?: (channelId: string) => void;
  /** The dead-channel empty state's way out — navigate to the bare channel
   * list instead of retrying an id that can never resolve. */
  readonly onBackToChannelList?: () => void;
}) {
  const queryClient = useQueryClient();
  const refreshChannelLists = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: channelsQueryKeyPrefix(tenantId),
    });
  }, [queryClient, tenantId]);
  const { state: channelsState, reload: reloadChannels } =
    useChannelLists(tenantId);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    null,
  );
  const activeChannelId = controlledChannelId ?? selectedChannelId;
  const setActiveChannelId = (id: string) => {
    setSelectedChannelId(id);
    onChannelChange?.(id);
  };
  const [messagesState, setMessagesState] = useState<MessagesState>({
    kind: "loading",
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createChannelError, setCreateChannelError] = useState<string | null>(
    null,
  );
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  // null = channel root feed. A concrete id opens that thread in the same
  // geometry (timeline + composer). pendingParentMessageId is set when the
  // user opens a reply on a message that has no thread yet.
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [pendingParentMessageId, setPendingParentMessageId] = useState<
    string | null
  >(null);
  const [threads, setThreads] = useState<readonly ChannelThread[]>([]);
  // Root-thread id from listThreads — used so the root feed loads
  // root-thread membership only, not the full channel mailbox.
  const [rootThreadId, setRootThreadId] = useState<string | null>(null);
  const [threadMetaByMessageId, setThreadMetaByMessageId] = useState<
    ReadonlyMap<string, ThreadAffordanceMeta>
  >(new Map());
  // Absent (not `[]`) until the first successful `listPinnedMessages` —
  // `undefined` means "not wired or not loaded yet", so the pinned strip
  // renders nothing rather than a fabricated empty state on channel
  // switch. A 404 (no `pins` store on the host) resolves to `[]` and
  // stays there — the strip is simply never shown for that deployment.
  const [pinnedMessages, setPinnedMessages] = useState<
    readonly PinnedMessage[]
  >([]);
  // This composer's own optimistic sends — see `mergePendingSends`. A
  // channel switch drops whatever was pending in the previous channel:
  // its composer submit targeted that channel, not wherever the reader
  // navigated to next.
  const [pendingSends, setPendingSends] = useState<readonly PendingSend[]>([]);

  const unauthorizedRef = useRef(false);
  const composerRef = useRef<ComposerHandle>(null);

  const loadThreads = useCallback(
    async (channelId: string) => {
      try {
        const page = await listThreads(tenantId, channelId);
        setThreads(page.items);
        setRootThreadId(page.rootThreadId !== "" ? page.rootThreadId : null);
        // Build affordance meta for parent messages that already have a
        // reply thread. Reply counts load lazily when the thread is opened;
        // until then we surface "Thread" via replyCount 0+.
        const replyThreads = page.items.filter(
          (t) => t.kind === "reply" && t.parentMessageId !== null,
        );
        const meta = new Map<string, ThreadAffordanceMeta>();
        await Promise.all(
          replyThreads.map(async (thread) => {
            if (thread.parentMessageId === null) return;
            try {
              const detail = await listThreadMessages(
                tenantId,
                channelId,
                thread.id,
              );
              const items = detail.items;
              const addresses = [
                ...new Set(
                  items
                    .map((item) => item.sender?.address)
                    .filter((a): a is string => typeof a === "string"),
                ),
              ];
              const last = items.at(-1);
              meta.set(thread.parentMessageId, {
                replyCount: items.length,
                lastActivityAt: last?.createdAt ?? thread.createdAt,
                participantAddresses: addresses,
              });
            } catch {
              meta.set(thread.parentMessageId, {
                replyCount: 0,
                lastActivityAt: thread.createdAt,
                participantAddresses: [],
              });
            }
          }),
        );
        setThreadMetaByMessageId(meta);
      } catch {
        setThreads([]);
        setRootThreadId(null);
        setThreadMetaByMessageId(new Map());
      }
    },
    [tenantId],
  );

  const loadPins = useCallback(
    async (channelId: string) => {
      try {
        setPinnedMessages(await listPinnedMessages(tenantId, channelId));
      } catch {
        // No `pins` store on this host, or a transient read failure —
        // either way the strip just doesn't show, the same "absent
        // store, absent surface" contract the wire's own `pinned` field
        // follows server-side.
        setPinnedMessages([]);
      }
    },
    [tenantId],
  );

  // `background: true` is a refresh from SSE/polling: the previous ready
  // items stay on screen (and the composer stays mounted) until fresh data
  // lands, and a failed background refresh is swallowed rather than
  // replacing the timeline with an error page. Only a first load or a
  // channel switch (background left false) shows the loading skeleton or
  // an error state.
  const loadMessages = useCallback(
    async (channelId: string, options?: { readonly background?: boolean }) => {
      const background = options?.background ?? false;
      if (!background) setMessagesState({ kind: "loading" });
      try {
        // Root feed may race with loadThreads on channel switch: if we
        // don't yet know the root thread id, resolve it from listThreads
        // before loading messages so we never fall back to full mail while
        // threads are available.
        let resolvedRootThreadId = rootThreadId;
        if (
          openThreadId === null &&
          pendingParentMessageId === null &&
          (resolvedRootThreadId === null || resolvedRootThreadId === "")
        ) {
          try {
            const threadsPage = await listThreads(tenantId, channelId);
            resolvedRootThreadId =
              threadsPage.rootThreadId !== "" ? threadsPage.rootThreadId : null;
            setRootThreadId(resolvedRootThreadId);
            setThreads(threadsPage.items);
          } catch {
            resolvedRootThreadId = null;
          }
        }

        const target = resolveMessageFeedTarget({
          openThreadId,
          pendingParentMessageId,
          rootThreadId: resolvedRootThreadId,
        });

        async function fetchTarget(
          fetchFor: MessageFeedTarget,
        ): Promise<MessageItem[]> {
          switch (fetchFor.kind) {
            case "thread": {
              const page = await listThreadMessages(
                tenantId,
                channelId,
                fetchFor.threadId,
              );
              return sortMessagesOldestFirst(page.items);
            }
            case "empty":
              // Brand-new reply thread — nothing to load yet.
              return [];
            case "root-thread": {
              const page = await listThreadMessages(
                tenantId,
                channelId,
                fetchFor.rootThreadId,
              );
              // Membership order is assignment order; timeline wants
              // oldest-first with the viewport pinned to the end.
              return sortMessagesOldestFirst(page.items);
            }
            case "channel-mail": {
              // Threads not available on this hub — full mailbox is the
              // only feed source (and there is no reply-thread
              // membership to mix in).
              const page = await listMessages(tenantId, channelId);
              return sortMessagesOldestFirst(page.items);
            }
          }
        }

        let items: MessageItem[];
        try {
          items = await fetchTarget(target);
        } catch (cause) {
          // A remembered thread id can outlive the server-side run it
          // named — e.g. across a hub restart (CL-6067), where the
          // reconnect-ownership challenge treats the run as dead and
          // every id under it 404s from here on. That is a stale
          // reference, not a real failure: discard it and fall back to
          // the channel's live feed instead of a dead-end error a "Try
          // again" can never actually recover from.
          const isStaleThreadRef =
            cause instanceof ChatApiError &&
            cause.status === 404 &&
            (target.kind === "thread" || target.kind === "root-thread");
          if (!isStaleThreadRef) throw cause;
          if (target.kind === "thread") setOpenThreadId(null);
          if (target.kind === "root-thread") setRootThreadId(null);
          const fallbackTarget = resolveMessageFeedTarget({
            openThreadId: target.kind === "thread" ? null : openThreadId,
            pendingParentMessageId,
            rootThreadId:
              target.kind === "root-thread" ? null : resolvedRootThreadId,
          });
          items = await fetchTarget(fallbackTarget);
        }
        setMessagesState((current) =>
          nextMessagesState(current, { kind: "success", items }, background),
        );
        if (openThreadId === null && pendingParentMessageId === null) {
          const last = items.at(-1);
          if (last !== undefined) {
            await putReadState(tenantId, channelId, {
              lastSeenCreatedAt: last.createdAt,
              lastSeenId: last.id,
            }).catch(() => undefined);
          }
        }
      } catch (cause) {
        // A 401 is terminal for this session: keep polling and the app
        // would hammer the hub unauthenticated forever. Halt refreshes
        // until the user switches channels or signs back in.
        if (cause instanceof ChatApiError && cause.status === 401) {
          unauthorizedRef.current = true;
        }
        // A 404 here means the channel itself is gone (deleted, or a stale
        // id from a Recents entry that outlived it) — not a transient load
        // failure a retry could fix. Tell the host so it can drop the dead
        // Recents entry the same way it dropped the dead thread ref above.
        const channelNotFound =
          cause instanceof ChatApiError && cause.status === 404;
        if (channelNotFound) onChannelNotFound?.(channelId);
        const message = describeChatError(cause, "Couldn't load messages.");
        setMessagesState((current) =>
          nextMessagesState(
            current,
            { kind: "error", message, channelNotFound },
            background,
          ),
        );
      }
    },
    [
      tenantId,
      openThreadId,
      pendingParentMessageId,
      rootThreadId,
      onChannelNotFound,
    ],
  );

  // Picking a default channel is this component's own fallback for "no
  // channel named in the URL yet" — it must never fire while the New
  // Channel dialog is open. That dialog's own submit is the user
  // explicitly picking a channel; letting this effect's own
  // `setActiveChannelId`/`onChannelChange` (and therefore `navigate`) fire
  // concurrently with the dialog's in-flight create raced the two against
  // each other over the same `activeChannelId`/URL (CL-6087). Once the
  // dialog closes (submitted or cancelled) this re-evaluates and still
  // covers the plain "no channel in the URL, nothing else going on" case.
  useEffect(() => {
    if (channelsState.kind !== "ready") return;
    if (activeChannelId !== null) return;
    if (dialogOpen) return;
    const first = channelsState.channels[0] ?? channelsState.chats[0];
    if (first !== undefined) setActiveChannelId(first.id);
  }, [channelsState, activeChannelId, dialogOpen]);

  useEffect(() => {
    unauthorizedRef.current = false;
    setOpenThreadId(null);
    setPendingParentMessageId(null);
    setRootThreadId(null);
    setPendingSends([]);
    if (activeChannelId !== null) {
      void loadThreads(activeChannelId);
      void loadMessages(activeChannelId);
      void loadPins(activeChannelId);
    }
  }, [activeChannelId]); // eslint-disable-line react-hooks/exhaustive-deps -- channel switch resets thread view

  useEffect(() => {
    if (activeChannelId === null) return;
    void loadMessages(activeChannelId);
  }, [openThreadId, pendingParentMessageId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Host shell opens the new-channel dialog from the contextual panel action.
  useEffect(() => {
    const onNewChannel = () => {
      setCreateChannelError(null);
      setDialogOpen(true);
    };
    window.addEventListener("workbench:chat:new-channel", onNewChannel);
    return () =>
      window.removeEventListener("workbench:chat:new-channel", onNewChannel);
  }, []);

  const refreshUnlessUnauthorized = () => {
    if (unauthorizedRef.current) return;
    if (activeChannelId !== null) {
      void loadMessages(activeChannelId, { background: true });
      void loadThreads(activeChannelId);
    }
  };

  const handleToggleReaction = useCallback(
    (messageId: string, emoji: string) => {
      if (activeChannelId === null) return;
      toggleReaction(tenantId, activeChannelId, messageId, emoji)
        .then(() => loadMessages(activeChannelId, { background: true }))
        .catch(() => toast(CHAT_STRINGS.reactionToggleError));
    },
    [tenantId, activeChannelId, loadMessages],
  );

  const handlePinMessage = useCallback(
    (messageId: string) => {
      if (activeChannelId === null) return;
      pinMessage(tenantId, activeChannelId, messageId)
        .then(() =>
          Promise.all([
            loadMessages(activeChannelId, { background: true }),
            loadPins(activeChannelId),
          ]),
        )
        .catch(() => toast(CHAT_STRINGS.pinMessageError));
    },
    [tenantId, activeChannelId, loadMessages, loadPins],
  );

  const handleUnpinMessage = useCallback(
    (messageId: string) => {
      if (activeChannelId === null) return;
      unpinMessage(tenantId, activeChannelId, messageId)
        .then(() =>
          Promise.all([
            loadMessages(activeChannelId, { background: true }),
            loadPins(activeChannelId),
          ]),
        )
        .catch(() => toast(CHAT_STRINGS.unpinMessageError));
    },
    [tenantId, activeChannelId, loadMessages, loadPins],
  );

  const reactionActions: ReactionActions = useMemo(
    () => ({ onToggle: handleToggleReaction }),
    [handleToggleReaction],
  );
  const pinActions: PinActions = useMemo(
    () => ({ onPin: handlePinMessage, onUnpin: handleUnpinMessage }),
    [handlePinMessage, handleUnpinMessage],
  );

  function jumpToMessage(messageId: string) {
    document
      .getElementById(messageDomId(messageId))
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const composerMounted =
    !settingsOpen && activeChannelId !== null && messagesState.kind === "ready";

  useEffect(() => {
    if (registerComposerInsert === undefined) return;
    if (!composerMounted) {
      registerComposerInsert(null);
      return;
    }
    registerComposerInsert((text) => composerRef.current?.insertText(text));
    return () => registerComposerInsert(null);
  }, [registerComposerInsert, composerMounted]);

  const { typingState, handleStreamEvent: handleTypingEvent } =
    useTypingIndicator(currentUser?.principalId, activeChannelId);

  useChannelStream(
    activeChannelId !== null ? channelStreamUrl(tenantId, activeChannelId) : "",
    (eventType, data) => {
      handleTypingEvent(eventType, data);
      if (eventType !== "chat.typing") refreshUnlessUnauthorized();
      if (eventType === "chat.pin" && activeChannelId !== null) {
        void loadPins(activeChannelId);
      }
    },
    refreshUnlessUnauthorized,
  );

  async function handleCreateChannel(
    input: CreateChannelInput,
    purpose?: string,
  ) {
    setCreating(true);
    setCreateChannelError(null);
    try {
      const created = await createChannel(tenantId, input);
      // `POST /channels` carries no purpose field (see
      // `NewChannelDialog`'s `onCreate` doc comment) — persisted with a
      // follow-up settings PATCH once the channel exists. Best-effort: the
      // channel itself was already created successfully, so a failure to
      // save its purpose shouldn't surface as a channel-creation error.
      if (purpose !== undefined) {
        try {
          await patchChannelSettings(tenantId, created.id, {
            "chat/purpose": purpose,
          });
        } catch {
          // best-effort, see comment above
        }
      }
      setDialogOpen(false);
      refreshChannelLists();
      setActiveChannelId(created.id);
      toast(CHAT_STRINGS.channelCreatedToast(created.title));
    } catch (cause) {
      const message =
        cause instanceof ChatApiError && cause.status === 400
          ? CHAT_STRINGS.newChannelMissingAgentError
          : CHAT_STRINGS.newChannelCreateError;
      setCreateChannelError(message);
    } finally {
      setCreating(false);
    }
  }

  /** The one door into the channel settings surface — the gear button and
   * the composer's `/agents` command both go through this so the section
   * that lands is always the one the caller meant to open. */
  function openChannelSettings(section: ChannelSettingsSectionId = "general") {
    onSettingsOpenChange?.(true, section);
  }

  async function handleInvite(definitionId: string) {
    if (activeChannelId === null) return;
    await inviteAgent(tenantId, activeChannelId, definitionId);
    // The invited agent's address lands on the channel's participants
    // (the mention popover picks it up via the reload below) and its
    // join event lands on the timeline.
    refreshChannelLists();
    await loadMessages(activeChannelId);
  }

  /**
   * The optimistic core both a fresh composer submit and a bubble's own
   * Retry button drive: adds (or resets) a pending entry before the
   * request goes out, so the sender sees their message land in the
   * timeline immediately rather than waiting on the round-trip, then
   * either drops the pending entry (the next `loadMessages` folds in the
   * server's real one) or flips it to `"failed"` in place — never a
   * status line disconnected from the message it describes.
   */
  async function sendPending(
    nonce: string,
    text: string,
    attachments: readonly ComposerAttachment[],
  ): Promise<void> {
    if (activeChannelId === null) return;
    const parts = partsForSend(text, attachments);
    if (parts.length === 0) return;
    try {
      if (openThreadId !== null) {
        await sendMessage(tenantId, activeChannelId, parts, {
          threadId: openThreadId,
        });
      } else if (pendingParentMessageId !== null) {
        const sent = await sendMessage(tenantId, activeChannelId, parts, {
          inReplyToMessageId: pendingParentMessageId,
        });
        if (sent.threadId !== undefined) {
          setOpenThreadId(sent.threadId);
          setPendingParentMessageId(null);
        }
      } else {
        await sendMessage(tenantId, activeChannelId, parts);
      }
      setPendingSends((current) => current.filter((p) => p.nonce !== nonce));
      await loadThreads(activeChannelId);
      await loadMessages(activeChannelId, { background: true });
    } catch {
      setPendingSends((current) =>
        current.map((p) =>
          p.nonce === nonce ? { ...p, status: "failed" } : p,
        ),
      );
    }
  }

  async function handleSend(payload: ComposerSendPayload): Promise<boolean> {
    if (activeChannelId === null) return false;
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
      },
    ]);
    await sendPending(nonce, payload.text, payload.attachments);
    return true;
  }

  function retryPendingSend(nonce: string) {
    const pending = pendingSends.find((p) => p.nonce === nonce);
    if (pending === undefined) return;
    setPendingSends((current) =>
      current.map((p) => (p.nonce === nonce ? { ...p, status: "sending" } : p)),
    );
    void sendPending(nonce, pending.text, pending.attachments);
  }

  /** Drops the failed pending bubble and hands its text back to the
   * composer's draft — the only door recovered text comes back through,
   * since a submit always clears the box on the way out. */
  function discardPendingSend(nonce: string) {
    const pending = pendingSends.find((p) => p.nonce === nonce);
    if (pending === undefined) return;
    setPendingSends((current) => current.filter((p) => p.nonce !== nonce));
    if (pending.text.length > 0) {
      composerRef.current?.insertText(pending.text);
    }
  }

  function openThreadForMessage(messageId: string) {
    const existing = threads.find(
      (t) => t.kind === "reply" && t.parentMessageId === messageId,
    );
    if (existing !== undefined) {
      setPendingParentMessageId(null);
      setOpenThreadId(existing.id);
      return;
    }
    setOpenThreadId(null);
    setPendingParentMessageId(messageId);
  }

  /**
   * The fork affordance (CL-5948): any message inside an open thread can
   * spawn a sub-thread rooted at it. Unlike the lazy root-feed reply
   * above, a fork is created eagerly — the server resolves depth (a new
   * depth-2 sub-thread, or a depth-cap-redirected sibling if the origin
   * message is already inside one) so this UI never has to reason about
   * nesting itself.
   */
  async function forkMessage(messageId: string) {
    if (activeChannelId === null) return;
    const existing = threads.find(
      (t) => t.kind === "reply" && t.parentMessageId === messageId,
    );
    if (existing !== undefined) {
      setPendingParentMessageId(null);
      setOpenThreadId(existing.id);
      return;
    }
    try {
      const forked = await forkThread(tenantId, activeChannelId, messageId);
      await loadThreads(activeChannelId);
      setPendingParentMessageId(null);
      setOpenThreadId(forked.id);
    } catch {
      toast(CHAT_STRINGS.forkThreadError);
    }
  }

  function closeThread() {
    setOpenThreadId(null);
    setPendingParentMessageId(null);
  }

  const activeChannel =
    channelsState.kind === "ready"
      ? [...channelsState.channels, ...channelsState.chats].find(
          (channel) => channel.id === activeChannelId,
        )
      : undefined;
  const isActiveChat =
    activeChannel !== undefined &&
    isKnownChannelKind(activeChannel.kind) &&
    activeChannel.kind === "chat";
  const activeChatAgent = isActiveChat
    ? activeChannel?.participants.find((participant) =>
        isAgentAddress(participant.address),
      )
    : undefined;

  // A settings URL for a channel id that resolved channels don't contain
  // (deleted, mistyped, cross-tenant) would otherwise leave the surface
  // silently showing the ordinary chat view under a lying /settings URL —
  // correct the route instead of no-opping.
  useEffect(() => {
    if (!settingsOpen) return;
    if (channelsState.kind !== "ready") return;
    if (activeChannelId === null) return;
    if (activeChannel !== undefined) return;
    onSettingsOpenChange?.(false);
  }, [
    settingsOpen,
    channelsState.kind,
    activeChannelId,
    activeChannel,
    onSettingsOpenChange,
  ]);

  const replyThreads = useMemo(
    () => threads.filter((t) => t.kind === "reply"),
    [threads],
  );
  // Two levels, stop: a depth-1 thread hangs off the root; a depth-2
  // sub-thread hangs off a depth-1 thread (CL-5908). Grouping threads
  // menu items and the breadcrumb both key off this same split.
  const depth1Threads = useMemo(
    () => replyThreads.filter((t) => t.parentThreadId === rootThreadId),
    [replyThreads, rootThreadId],
  );
  const subThreadsByParentId = useMemo(() => {
    const map = new Map<string, ChannelThread[]>();
    for (const t of replyThreads) {
      if (t.parentThreadId === null || t.parentThreadId === rootThreadId) {
        continue;
      }
      const list = map.get(t.parentThreadId) ?? [];
      map.set(t.parentThreadId, [...list, t]);
    }
    return map;
  }, [replyThreads, rootThreadId]);
  const openThread =
    openThreadId === null
      ? undefined
      : threads.find((t) => t.id === openThreadId);
  // A sub-thread's breadcrumb parent segment — undefined for a depth-1
  // thread (or no thread open at all), which breadcrumbs straight back to
  // the channel.
  const openThreadParent =
    openThread?.parentThreadId !== undefined &&
    openThread.parentThreadId !== null &&
    openThread.parentThreadId !== rootThreadId
      ? threads.find((t) => t.id === openThread.parentThreadId)
      : undefined;
  const inThreadView = openThreadId !== null || pendingParentMessageId !== null;
  const threadTitle =
    openThread?.title ??
    (pendingParentMessageId !== null ? "New thread" : "Thread");
  // Member stack: up to three participant handles for the top bar.
  const memberStack = (activeChannel?.participants ?? []).slice(0, 3);

  // The channel header only exists once a channel is active; the loading,
  // error, and no-channel states still carry the host's leading control (the
  // shell's col2 toggle) so the sidebar stays reachable.
  const bareLeadingHeader =
    headerLeading !== undefined &&
    (channelsState.kind !== "ready" || activeChannelId === null) ? (
      <div className="chat-channel-header">{headerLeading}</div>
    ) : null;

  if (settingsOpen && activeChannelId !== null && activeChannel !== undefined) {
    return (
      <>
        <div className="chat-workspace">
          <ChannelSettingsSurface
            key={activeChannelId}
            tenantId={tenantId}
            channelId={activeChannelId}
            channelTitle={activeChannel.title || CHAT_STRINGS.unnamedChannel}
            section={settingsSection}
            onSectionChange={(next) => onSettingsSectionChange?.(next)}
            onBack={() => onSettingsOpenChange?.(false)}
            onInviteParticipant={() => {
              onSettingsOpenChange?.(false);
              setInviteDialogOpen(true);
            }}
            onSaved={refreshChannelLists}
          />
        </div>
        <NewChannelDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onCreate={(input, purpose) =>
            void handleCreateChannel(input, purpose)
          }
          tenantId={tenantId}
          submitting={creating}
          error={createChannelError}
          initialKind="chat"
          {...(listMembers !== undefined ? { listMembers } : {})}
          {...(currentUser !== undefined
            ? { currentUserPrincipalId: currentUser.principalId }
            : {})}
          {...(onRequestNewAgent !== undefined
            ? {
                onRequestNewAgent: () => {
                  setDialogOpen(false);
                  onRequestNewAgent();
                },
              }
            : {})}
        />
        <InviteAgentDialog
          open={inviteDialogOpen}
          onOpenChange={setInviteDialogOpen}
          tenantId={tenantId}
          channelId={activeChannelId}
          onInvite={handleInvite}
        />
      </>
    );
  }

  return (
    <>
      <div className="chat-workspace">
        <div className="chat-main">
          {bareLeadingHeader}
          {channelsState.kind === "loading" ? (
            <Skeleton className="query-skeleton" />
          ) : channelsState.kind === "error" ? (
            <EmptyState
              icon={<CircleAlert />}
              title={`Couldn't load ${CHAT_STRINGS.couldNotLoadChannels}`}
              description={channelsState.message}
              action={
                <Button variant="outline" onClick={() => void reloadChannels()}>
                  Try again
                </Button>
              }
            />
          ) : activeChannelId === null ? (
            <EmptyState
              icon={<MessageSquare />}
              title={CHAT_STRINGS.noChatSelectedTitle}
              description={CHAT_STRINGS.noChatSelectedDescription}
            />
          ) : (
            <>
              <div className="chat-channel-header">
                {headerLeading}
                {inThreadView ? (
                  <nav className="chat-thread-breadcrumb" aria-label="Thread">
                    <button
                      type="button"
                      className="chat-thread-breadcrumb-link"
                      onClick={closeThread}
                    >
                      {activeChannel?.title || CHAT_STRINGS.unnamedChannel}
                    </button>
                    <span
                      className="chat-thread-breadcrumb-sep"
                      aria-hidden="true"
                    >
                      /
                    </span>
                    {openThreadParent !== undefined ? (
                      <>
                        <button
                          type="button"
                          className="chat-thread-breadcrumb-link"
                          onClick={() => {
                            setPendingParentMessageId(null);
                            setOpenThreadId(openThreadParent.id);
                          }}
                        >
                          {openThreadParent.title ?? "Thread"}
                        </button>
                        <span
                          className="chat-thread-breadcrumb-sep"
                          aria-hidden="true"
                        >
                          /
                        </span>
                      </>
                    ) : null}
                    <span
                      className="chat-thread-breadcrumb-current"
                      aria-current="page"
                    >
                      {threadTitle}
                    </span>
                  </nav>
                ) : (
                  <div className="chat-channel-identity">
                    <h2 className="chat-channel-title">
                      {activeChannel?.title || CHAT_STRINGS.unnamedChannel}
                    </h2>
                    {activeChatAgent !== undefined ? <AgentBadge /> : null}
                  </div>
                )}
                <div className="chat-channel-actions">
                  <details className="chat-threads-menu">
                    <summary className="chat-threads-menu-trigger">
                      {depth1Threads.length}{" "}
                      {depth1Threads.length === 1 ? "thread" : "threads"}
                      <ChevronDown className="size-3.5 opacity-70" />
                    </summary>
                    <div className="chat-threads-menu-panel" role="menu">
                      {depth1Threads.length === 0 ? (
                        <div className="chat-threads-menu-empty">
                          No threads yet
                        </div>
                      ) : (
                        depth1Threads.map((thread) => (
                          <div
                            key={thread.id}
                            className="chat-threads-menu-group"
                          >
                            <button
                              type="button"
                              role="menuitem"
                              className="chat-threads-menu-item"
                              onClick={() => {
                                setPendingParentMessageId(null);
                                setOpenThreadId(thread.id);
                              }}
                            >
                              {thread.title ??
                                (thread.parentMessageId !== null
                                  ? `Reply · ${thread.parentMessageId.slice(0, 8)}`
                                  : "Thread")}
                            </button>
                            {(subThreadsByParentId.get(thread.id) ?? []).map(
                              (subThread) => (
                                <button
                                  key={subThread.id}
                                  type="button"
                                  role="menuitem"
                                  className="chat-threads-menu-item chat-threads-menu-item-nested"
                                  onClick={() => {
                                    setPendingParentMessageId(null);
                                    setOpenThreadId(subThread.id);
                                  }}
                                >
                                  {subThread.title ??
                                    (subThread.parentMessageId !== null
                                      ? `Fork · ${subThread.parentMessageId.slice(0, 8)}`
                                      : "Sub-thread")}
                                </button>
                              ),
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </details>
                  {memberStack.length > 0 ? (
                    <div className="chat-member-stack" aria-label="Members">
                      {memberStack.map((participant) => (
                        <span
                          key={participant.address}
                          className="chat-sender-avatar"
                          title={participant.handle}
                        >
                          {participant.handle.slice(0, 1).toUpperCase()}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {presenceMembers !== undefined &&
                  presenceMembers.length > 0 ? (
                    <div className="chat-presence-stack" aria-label="Live now">
                      {presenceMembers.slice(0, 5).map((member) => (
                        <span
                          key={member.principalId}
                          className="chat-presence-avatar"
                          style={{ backgroundColor: member.color }}
                          title={member.displayName}
                        >
                          {member.displayName.slice(0, 1).toUpperCase()}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {canInviteAgent(activeChannel?.kind) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setInviteDialogOpen(true)}
                    >
                      <UserPlus />
                      {CHAT_STRINGS.inviteAgentAction}
                    </Button>
                  ) : null}
                  {onCreateRoutineInSpace !== undefined &&
                  activeChannelId !== null ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onCreateRoutineInSpace(activeChannelId)}
                    >
                      <Repeat />
                      New routine
                    </Button>
                  ) : null}
                  {onOpenInsights !== undefined ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onOpenInsights()}
                    >
                      <ChartColumn />
                      Insights
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={CHAT_STRINGS.channelSettingsAction}
                    onClick={() => openChannelSettings()}
                  >
                    <SlidersHorizontal />
                  </Button>
                </div>
              </div>
              {messagesState.kind === "loading" ? (
                <Skeleton className="query-skeleton" />
              ) : messagesState.kind === "error" &&
                messagesState.channelNotFound ? (
                <EmptyState
                  icon={<CircleAlert />}
                  title={CHAT_STRINGS.channelNotFoundTitle}
                  description={CHAT_STRINGS.channelNotFoundDescription}
                  action={
                    onBackToChannelList !== undefined ? (
                      <Button variant="outline" onClick={onBackToChannelList}>
                        {CHAT_STRINGS.channelNotFoundAction}
                      </Button>
                    ) : undefined
                  }
                />
              ) : messagesState.kind === "error" ? (
                <EmptyState
                  icon={<CircleAlert />}
                  title={`Couldn't load ${CHAT_STRINGS.couldNotLoadMessages}`}
                  description={messagesState.message}
                  action={
                    <Button
                      variant="outline"
                      onClick={() => void loadMessages(activeChannelId)}
                    >
                      Try again
                    </Button>
                  }
                />
              ) : (
                <>
                  {!inThreadView ? (
                    <PinnedStrip
                      items={pinnedMessages}
                      onJump={jumpToMessage}
                    />
                  ) : null}
                  {openThreadParent !== undefined ? (
                    <div className="chat-thread-origin-banner">
                      {CHAT_STRINGS.forkThreadOriginBanner}{" "}
                      <button
                        type="button"
                        className="chat-thread-origin-banner-link"
                        onClick={() => {
                          setPendingParentMessageId(null);
                          setOpenThreadId(openThreadParent.id);
                        }}
                      >
                        {openThreadParent.title ?? "Thread"}
                      </button>
                    </div>
                  ) : null}
                  <ChannelTimeline
                    items={mergePendingSends(
                      messagesState.items,
                      pendingSends,
                      currentUser?.principalId,
                    )}
                    participants={activeChannel?.participants ?? []}
                    {...(currentUser !== undefined ? { currentUser } : {})}
                    threadMetaByMessageId={threadMetaByMessageId}
                    threadAffordanceMode={inThreadView ? "fork" : "reply"}
                    onOpenThread={
                      inThreadView ? forkMessage : openThreadForMessage
                    }
                    {...(onOpenProfile !== undefined ? { onOpenProfile } : {})}
                    {...(onOpenArtifact !== undefined
                      ? { onOpenArtifact }
                      : {})}
                    {...(onOpenArtifactInLibrary !== undefined
                      ? { onOpenArtifactInLibrary }
                      : {})}
                    {...(onFixConnection !== undefined
                      ? { onFixConnection }
                      : {})}
                    {...(approvalActions !== undefined
                      ? { approvalActions }
                      : {})}
                    {...(blockResponses !== undefined
                      ? { blockResponses }
                      : {})}
                    reactionActions={reactionActions}
                    pinActions={pinActions}
                    pendingActions={{
                      onRetry: retryPendingSend,
                      onDiscard: discardPendingSend,
                    }}
                  />
                  {typingState !== null ? (
                    <TypingIndicator
                      label={typingLabel(
                        typingState.principalId,
                        activeChannel?.participants ?? [],
                      )}
                    />
                  ) : null}
                  <Composer
                    ref={composerRef}
                    agents={mentionCandidatesFromParticipants(
                      activeChannel?.participants ?? [],
                    )}
                    placeholder={composerPlaceholderFor(activeChannel)}
                    onSend={handleSend}
                    onInviteAgent={() => setInviteDialogOpen(true)}
                    onOpenAgentsSettings={() => openChannelSettings("agents")}
                    onOpenRoutines={() => {
                      if (onOpenRoutines !== undefined) {
                        onOpenRoutines();
                        return;
                      }
                      toast(CHAT_STRINGS.runRoutineUnavailable);
                    }}
                    onCreateRoutineInSpace={() => {
                      if (
                        onCreateRoutineInSpace !== undefined &&
                        activeChannelId !== null
                      ) {
                        onCreateRoutineInSpace(activeChannelId);
                        return;
                      }
                      toast(CHAT_STRINGS.runRoutineUnavailable);
                    }}
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>
      <NewChannelDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreate={(input, purpose) => void handleCreateChannel(input, purpose)}
        tenantId={tenantId}
        submitting={creating}
        error={createChannelError}
        initialKind="chat"
        {...(listMembers !== undefined ? { listMembers } : {})}
        {...(currentUser !== undefined
          ? { currentUserPrincipalId: currentUser.principalId }
          : {})}
        {...(onRequestNewAgent !== undefined
          ? {
              onRequestNewAgent: () => {
                setDialogOpen(false);
                onRequestNewAgent();
              },
            }
          : {})}
      />
      {activeChannelId !== null ? (
        <InviteAgentDialog
          open={inviteDialogOpen}
          onOpenChange={setInviteDialogOpen}
          tenantId={tenantId}
          channelId={activeChannelId}
          onInvite={handleInvite}
        />
      ) : null}
    </>
  );
}

function ChatWorkspaceFrame({ children }: { readonly children: ReactNode }) {
  return <div className="chat-workspace-frame">{children}</div>;
}

export function ChatWorkspace({
  tenant,
  channelId = null,
  onChannelChange,
  currentUser,
  onOpenProfile,
  settingsOpen,
  onSettingsOpenChange,
  settingsSection,
  onSettingsSectionChange,
  onOpenArtifact,
  onOpenArtifactInLibrary,
  onFixConnection,
  approvalActions,
  blockResponses,
  headerLeading,
  listMembers,
  registerComposerInsert,
  onOpenRoutines,
  onRequestNewAgent,
  onCreateRoutineInSpace,
  onOpenInsights,
  presenceMembers,
  onChannelNotFound,
  onBackToChannelList,
}: {
  readonly tenant: TenantResolution;
  /** Controlled active channel (e.g. from the app's URL); null = pick the first. */
  readonly channelId?: string | null;
  /** Fired when the user selects a channel, so the app can reflect it in the URL. */
  readonly onChannelChange?: (channelId: string) => void;
  /**
   * The signed-in account, so its own messages render as "You" (or its
   * name) instead of matching no participant and falling back to
   * "Member". Host-supplied, the same way `tenant` is — this package
   * never resolves a session itself.
   */
  readonly currentUser?: CurrentUser;
  /** Open a member/agent ProfileCard in the host canvas (shell mock § Profile). */
  readonly onOpenProfile?: (subject: ProfileSubject) => void;
  /** Whether the routed channel's settings surface should replace the
   * conversation stage — host-controlled from the URL (`/c/:id/settings`). */
  readonly settingsOpen?: boolean;
  /** Fired when the settings surface should open or close, so the host can
   * reflect it in the URL — see `ChatWorkspaceInner`'s prop of the same
   * name for the `section` argument's contract. */
  readonly onSettingsOpenChange?: (
    open: boolean,
    section?: ChannelSettingsSectionId,
  ) => void;
  /** Which channel settings tab is active — host-controlled from the URL
   * (`/c/:id/settings/:section`). */
  readonly settingsSection?: ChannelSettingsSectionId;
  /** Fired when the user switches tabs while the settings surface is
   * already open, so the host can reflect it in the URL. */
  readonly onSettingsSectionChange?: (
    section: ChannelSettingsSectionId,
  ) => void;
  /** Open a message's artifact chip — see `ChannelTimeline`'s `onOpenArtifact`. */
  readonly onOpenArtifact?: (part: Part & { kind: "file" }) => void;
  /** The chip's "Open in Library" affordance — see `ChannelTimeline`'s
   * `onOpenArtifactInLibrary`. */
  readonly onOpenArtifactInLibrary?: (part: Part & { kind: "file" }) => void;
  /** The classified-inference-failure text bubble's "Fix this connection"
   * action — see `ChannelTimeline`'s `onFixConnection` (CL-6092). */
  readonly onFixConnection?: () => void;
  /** The approve block's live round-trip — see `ChannelTimeline`'s
   * `approvalActions`. */
  readonly approvalActions?: ApprovalActions;
  /** The poll/form blocks' live round-trip — see `ChannelTimeline`'s
   * `blockResponses`. */
  readonly blockResponses?: BlockResponseActions;
  /** Host-supplied control rendered first in the channel header — the
   * shell's single col2 toggle, so chat carries the same top-bar chrome as
   * every other stage surface. */
  readonly headerLeading?: ReactNode;
  /**
   * The bench's people — the same source Settings → People renders from
   * — so the new-chat dialog can offer "chat with a teammate" alongside
   * "chat with an agent". Host-supplied, the same way `tenant` is; omitted
   * entirely, the dialog's People tab does not render at all.
   */
  readonly listMembers?: (tenantId: string) => Promise<readonly PersonOption[]>;
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly registerComposerInsert?: (
    insert: ((text: string) => void) | null,
  ) => void;
  /** The composer's `/run` command — see `ChatWorkspaceInner`'s prop note. */
  readonly onOpenRoutines?: () => void;
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly onRequestNewAgent?: () => void;
  /** "New routine in this space" — see `ChatWorkspaceInner`'s prop note. */
  readonly onCreateRoutineInSpace?: (channelId: string) => void;
  /**
   * "Insights for this workbench" — the header button that deep-links to
   * this tenant's own Insights scope (CL-6099). Host-supplied so the
   * Insights route (and its tenant-scope resolution) stays owned by the
   * host, the same way `onOpenRoutines` is. Omitted, the button is
   * hidden — the same "no dead promise" contract as the other optional
   * header actions here.
   */
  readonly onOpenInsights?: () => void;
  /**
   * Who's live in the active channel right now, beyond the static
   * participants list — the host's `@corbits/presence/client` connection,
   * handed down as data. Omitted entirely, no presence stack renders (the
   * header looks exactly as it did before presence existed).
   */
  readonly presenceMembers?: readonly PresenceMember[];
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly onChannelNotFound?: (channelId: string) => void;
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly onBackToChannelList?: () => void;
}) {
  switch (tenant.kind) {
    case "ready":
      // Remount on tenant switch so prior-tenant state cannot leak.
      return (
        <ChatWorkspaceInner
          key={tenant.tenantId}
          tenantId={tenant.tenantId}
          channelId={channelId}
          {...(onChannelChange !== undefined ? { onChannelChange } : {})}
          {...(currentUser !== undefined ? { currentUser } : {})}
          {...(onOpenProfile !== undefined ? { onOpenProfile } : {})}
          {...(settingsOpen !== undefined ? { settingsOpen } : {})}
          {...(onSettingsOpenChange !== undefined
            ? { onSettingsOpenChange }
            : {})}
          {...(settingsSection !== undefined ? { settingsSection } : {})}
          {...(onSettingsSectionChange !== undefined
            ? { onSettingsSectionChange }
            : {})}
          {...(approvalActions !== undefined ? { approvalActions } : {})}
          {...(blockResponses !== undefined ? { blockResponses } : {})}
          {...(onOpenArtifact !== undefined ? { onOpenArtifact } : {})}
          {...(onOpenArtifactInLibrary !== undefined
            ? { onOpenArtifactInLibrary }
            : {})}
          {...(onFixConnection !== undefined ? { onFixConnection } : {})}
          {...(headerLeading !== undefined ? { headerLeading } : {})}
          {...(listMembers !== undefined ? { listMembers } : {})}
          {...(registerComposerInsert !== undefined
            ? { registerComposerInsert }
            : {})}
          {...(onOpenRoutines !== undefined ? { onOpenRoutines } : {})}
          {...(onRequestNewAgent !== undefined ? { onRequestNewAgent } : {})}
          {...(onCreateRoutineInSpace !== undefined
            ? { onCreateRoutineInSpace }
            : {})}
          {...(onOpenInsights !== undefined ? { onOpenInsights } : {})}
          {...(presenceMembers !== undefined ? { presenceMembers } : {})}
          {...(onChannelNotFound !== undefined ? { onChannelNotFound } : {})}
          {...(onBackToChannelList !== undefined
            ? { onBackToChannelList }
            : {})}
        />
      );
    case "empty":
      return (
        <ChatWorkspaceFrame>
          <EmptyState
            icon={<MessageSquare />}
            title="No workbench yet"
            description="Create or join a workbench before chatting."
          />
        </ChatWorkspaceFrame>
      );
    case "unauthenticated":
      return (
        <ChatWorkspaceFrame>
          <EmptyState
            icon={<MessageSquare />}
            title="Sign in to continue"
            description="Your conversations live on a workbench — sign in to open them."
          />
        </ChatWorkspaceFrame>
      );
    case "error":
      return (
        <ChatWorkspaceFrame>
          <EmptyState
            icon={<CircleAlert />}
            title="Couldn't open this workbench"
            description={tenant.message}
          />
        </ChatWorkspaceFrame>
      );
    case "loading":
      return (
        <ChatWorkspaceFrame>
          <Skeleton className="query-skeleton" />
        </ChatWorkspaceFrame>
      );
  }
}
