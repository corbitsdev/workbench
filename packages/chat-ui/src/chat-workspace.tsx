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
import { Button, EmptyState, Skeleton } from "@corbits/react-ui";
import {
  ChevronDown,
  CircleAlert,
  MessageSquare,
  SlidersHorizontal,
  UserPlus,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  ChatApiError,
  createChannel,
  inviteAgent,
  listChannels,
  listMessages,
  listThreadMessages,
  listThreads,
  putReadState,
  sendMessage,
  channelStreamUrl,
  isKnownChannelKind,
} from "./api";
import type {
  Channel,
  ChannelThread,
  CreateChannelInput,
  MessageItem,
} from "./api";
import { ChannelSettingsPanel } from "./channel-settings-panel";
import { Composer, partsForSend } from "./composer";
import type { ComposerSendPayload } from "./composer";
import { InviteAgentDialog } from "./invite-agent-dialog";
import { mentionCandidatesFromParticipants } from "./mentions";
import { NewChannelDialog } from "./new-channel-dialog";
import { CHAT_STRINGS } from "./strings";
import { AgentBadge, ChannelTimeline } from "./timeline";
import type { CurrentUser, ThreadAffordanceMeta } from "./timeline";
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
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly MessageItem[] };

export type MessagesLoadOutcome =
  | { readonly kind: "success"; readonly items: readonly MessageItem[] }
  | { readonly kind: "error"; readonly message: string };

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
  return { kind: "error", message: outcome.message };
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

function useChannelLists(tenantId: string, refreshKey: number) {
  const [state, setState] = useState<ChannelsState>({ kind: "loading" });

  const reload = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const [channels, chats] = await Promise.all([
        listChannels(tenantId, "channel"),
        listChannels(tenantId, "chat"),
      ]);
      setState({ kind: "ready", channels, chats });
    } catch (cause) {
      setState({
        kind: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [tenantId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  return { state, reload };
}

function ChatWorkspaceInner({
  tenantId,
  channelId: controlledChannelId,
  onChannelChange,
  currentUser,
  onOpenProfile,
}: {
  readonly tenantId: string;
  readonly channelId?: string | null;
  readonly onChannelChange?: (channelId: string) => void;
  readonly currentUser?: CurrentUser;
  readonly onOpenProfile?: (subject: ProfileSubject) => void;
}) {
  const [channelsRefresh, setChannelsRefresh] = useState(0);
  const { state: channelsState, reload: reloadChannels } = useChannelLists(
    tenantId,
    channelsRefresh,
  );
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
  const [settingsChannelId, setSettingsChannelId] = useState<string | null>(
    null,
  );
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

  const unauthorizedRef = useRef(false);

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

        let items: MessageItem[];
        switch (target.kind) {
          case "thread": {
            const page = await listThreadMessages(
              tenantId,
              channelId,
              target.threadId,
            );
            items = sortMessagesOldestFirst(page.items);
            break;
          }
          case "empty":
            // Brand-new reply thread — nothing to load yet.
            items = [];
            break;
          case "root-thread": {
            const page = await listThreadMessages(
              tenantId,
              channelId,
              target.rootThreadId,
            );
            // Membership order is assignment order; timeline wants
            // oldest-first with the viewport pinned to the end.
            items = sortMessagesOldestFirst(page.items);
            break;
          }
          case "channel-mail": {
            // Threads not available on this hub — full mailbox is the
            // only feed source (and there is no reply-thread membership
            // to mix in).
            const page = await listMessages(tenantId, channelId);
            items = sortMessagesOldestFirst(page.items);
            break;
          }
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
        const message = cause instanceof Error ? cause.message : String(cause);
        setMessagesState((current) =>
          nextMessagesState(current, { kind: "error", message }, background),
        );
      }
    },
    [tenantId, openThreadId, pendingParentMessageId, rootThreadId],
  );

  useEffect(() => {
    if (channelsState.kind !== "ready") return;
    if (activeChannelId !== null) return;
    const first = channelsState.channels[0] ?? channelsState.chats[0];
    if (first !== undefined) setActiveChannelId(first.id);
  }, [channelsState, activeChannelId]);

  useEffect(() => {
    unauthorizedRef.current = false;
    setOpenThreadId(null);
    setPendingParentMessageId(null);
    setRootThreadId(null);
    if (activeChannelId !== null) {
      void loadThreads(activeChannelId);
      void loadMessages(activeChannelId);
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
  const streamState = useChannelStream(
    activeChannelId !== null ? channelStreamUrl(tenantId, activeChannelId) : "",
    refreshUnlessUnauthorized,
    refreshUnlessUnauthorized,
  );

  async function handleCreateChannel(input: CreateChannelInput) {
    setCreating(true);
    setCreateChannelError(null);
    try {
      const created = await createChannel(tenantId, input);
      setDialogOpen(false);
      setChannelsRefresh((value) => value + 1);
      setActiveChannelId(created.id);
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

  async function handleInvite(definitionId: string) {
    if (activeChannelId === null) return;
    await inviteAgent(tenantId, activeChannelId, definitionId);
    // The invited agent's address lands on the channel's participants
    // (the mention popover picks it up via the reload below) and its
    // join event lands on the timeline.
    setChannelsRefresh((value) => value + 1);
    await loadMessages(activeChannelId);
  }

  async function handleSend(payload: ComposerSendPayload): Promise<boolean> {
    if (activeChannelId === null) return false;
    const parts = partsForSend(payload.text, payload.attachments);
    if (parts.length === 0) return false;
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
      await loadThreads(activeChannelId);
      await loadMessages(activeChannelId, { background: true });
      return true;
    } catch {
      return false;
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

  const replyThreads = useMemo(
    () => threads.filter((t) => t.kind === "reply"),
    [threads],
  );
  const openThread =
    openThreadId === null
      ? undefined
      : threads.find((t) => t.id === openThreadId);
  const inThreadView = openThreadId !== null || pendingParentMessageId !== null;
  const threadTitle =
    openThread?.title ??
    (pendingParentMessageId !== null ? "New thread" : "Thread");
  // Member stack: up to three participant handles for the top bar.
  const memberStack = (activeChannel?.participants ?? []).slice(0, 3);

  return (
    <>
      <div className="chat-workspace">
        <div className="chat-main">
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
                    <span className="chat-thread-breadcrumb-current">
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
                      {replyThreads.length}{" "}
                      {replyThreads.length === 1 ? "thread" : "threads"}
                      <ChevronDown className="size-3.5 opacity-70" />
                    </summary>
                    <div className="chat-threads-menu-panel" role="menu">
                      {replyThreads.length === 0 ? (
                        <div className="chat-threads-menu-empty">
                          No threads yet
                        </div>
                      ) : (
                        replyThreads.map((thread) => (
                          <button
                            key={thread.id}
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
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={CHAT_STRINGS.channelSettingsAction}
                    onClick={() => setSettingsChannelId(activeChannelId)}
                  >
                    <SlidersHorizontal />
                  </Button>
                </div>
              </div>
              {messagesState.kind === "loading" ? (
                <Skeleton className="query-skeleton" />
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
                  {streamState !== "live" ? (
                    <div className="chat-stream-indicator" role="status">
                      {CHAT_STRINGS.reconnectingMessage}
                    </div>
                  ) : null}
                  <ChannelTimeline
                    items={messagesState.items}
                    participants={activeChannel?.participants ?? []}
                    {...(currentUser !== undefined ? { currentUser } : {})}
                    threadMetaByMessageId={threadMetaByMessageId}
                    onOpenThread={openThreadForMessage}
                    {...(onOpenProfile !== undefined ? { onOpenProfile } : {})}
                  />
                  <Composer
                    agents={mentionCandidatesFromParticipants(
                      activeChannel?.participants ?? [],
                    )}
                    onSend={handleSend}
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
        onCreate={(input) => void handleCreateChannel(input)}
        tenantId={tenantId}
        submitting={creating}
        error={createChannelError}
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
      {settingsChannelId !== null ? (
        <ChannelSettingsPanel
          open={settingsChannelId !== null}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setSettingsChannelId(null);
          }}
          tenantId={tenantId}
          channelId={settingsChannelId}
          onInviteParticipant={() => {
            setSettingsChannelId(null);
            setInviteDialogOpen(true);
          }}
          onSaved={() => setChannelsRefresh((value) => value + 1)}
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
        />
      );
    case "empty":
      return (
        <ChatWorkspaceFrame>
          <EmptyState
            icon={<MessageSquare />}
            title="No bench yet"
            description="Create or join a bench before chatting."
          />
        </ChatWorkspaceFrame>
      );
    case "unauthenticated":
      return (
        <ChatWorkspaceFrame>
          <EmptyState
            icon={<MessageSquare />}
            title="Sign in to chat"
            description="Your conversations live on a bench — sign in to open them."
          />
        </ChatWorkspaceFrame>
      );
    case "error":
      return (
        <ChatWorkspaceFrame>
          <EmptyState
            icon={<CircleAlert />}
            title="Couldn't open chat"
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
