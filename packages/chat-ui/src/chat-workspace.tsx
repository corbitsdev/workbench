// Orchestrates the whole chat surface: resolves which bench (tenant) this
// account chats in, loads its channels and deployed agents, and wires the
// sidebar, timeline, and composer together for whichever channel is
// selected. The chat API has no tenant switcher of its own yet — like the
// onboarding flow's personal bench, this uses the account's first bench
// membership.
//
// Resolving *which* bench that is is host-specific (it rides on
// whatever session/query plumbing the embedding app already has — in
// `@workbench/web` that is the same `/api/me/principals` call the Home
// and Settings pages use), so `ChatWorkspace` takes a small
// `TenantResolution` value rather than importing app code: the same
// narrow-port shape `@corbits/chat`'s `routes.ts` uses for `ChatPlatform`.

import {
  Button,
  EmptyState,
  Skeleton,
  TopBar,
  TopBarActions,
  TopBarTitle,
} from "@corbits/react-ui";
import { CircleAlert, Lock, MessageSquare, UserPlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  ChatApiError,
  createChannel,
  inviteAgent,
  listChannels,
  listMessages,
  putReadState,
  sendMessage,
  channelStreamUrl,
} from "./api";
import type { Channel, ChannelKind, MessageItem } from "./api";
import { Composer } from "./composer";
import { InviteAgentDialog } from "./invite-agent-dialog";
import { mentionCandidatesFromParticipants } from "./mentions";
import { NewChannelDialog } from "./new-channel-dialog";
import { ChatSidebar } from "./sidebar";
import { CHAT_STRINGS } from "./strings";
import { ChannelTimeline } from "./timeline";
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
 * This workspace compiles under `exactOptionalPropertyTypes`, and the
 * component library's optional props are declared without
 * `| undefined` — so an absent prop has to be omitted, not passed as
 * `undefined`.
 */
function subtitleProp(subtitle: string | undefined): { subtitle?: string } {
  return subtitle === undefined ? {} : { subtitle };
}

type ChannelsState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly channels: readonly Channel[];
      readonly chats: readonly Channel[];
    };

type MessagesState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly MessageItem[] };

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

function ChatWorkspaceInner({ tenantId }: { readonly tenantId: string }) {
  const [channelsRefresh, setChannelsRefresh] = useState(0);
  const { state: channelsState, reload: reloadChannels } = useChannelLists(
    tenantId,
    channelsRefresh,
  );
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [messagesState, setMessagesState] = useState<MessagesState>({
    kind: "loading",
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);

  const unauthorizedRef = useRef(false);
  const loadMessages = useCallback(
    async (channelId: string) => {
      setMessagesState({ kind: "loading" });
      try {
        const page = await listMessages(tenantId, channelId);
        setMessagesState({ kind: "ready", items: page.items });
        const last = page.items.at(-1);
        if (last !== undefined) {
          await putReadState(tenantId, channelId, {
            lastSeenCreatedAt: last.createdAt,
            lastSeenId: last.id,
          }).catch(() => undefined);
        }
      } catch (cause) {
        // A 401 is terminal for this session: keep polling and the app
        // would hammer the hub unauthenticated forever. Halt refreshes
        // until the user switches channels or signs back in.
        if (cause instanceof ChatApiError && cause.status === 401) {
          unauthorizedRef.current = true;
        }
        setMessagesState({
          kind: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    [tenantId],
  );

  useEffect(() => {
    if (channelsState.kind !== "ready") return;
    if (activeChannelId !== null) return;
    const first = channelsState.channels[0] ?? channelsState.chats[0];
    if (first !== undefined) setActiveChannelId(first.id);
  }, [channelsState, activeChannelId]);

  useEffect(() => {
    unauthorizedRef.current = false;
    if (activeChannelId !== null) void loadMessages(activeChannelId);
  }, [activeChannelId, loadMessages]);

  const refreshUnlessUnauthorized = () => {
    if (unauthorizedRef.current) return;
    if (activeChannelId !== null) void loadMessages(activeChannelId);
  };
  useChannelStream(
    activeChannelId !== null ? channelStreamUrl(tenantId, activeChannelId) : "",
    refreshUnlessUnauthorized,
    refreshUnlessUnauthorized,
  );

  async function handleCreateChannel(input: {
    name: string;
    kind: ChannelKind;
  }) {
    setCreating(true);
    try {
      const created = await createChannel(tenantId, input);
      setDialogOpen(false);
      setChannelsRefresh((value) => value + 1);
      setActiveChannelId(created.id);
    } catch {
      // The dialog stays open; the sidebar's own error state on the next
      // reload is the loud failure surface here.
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

  async function handleSend(text: string) {
    if (activeChannelId === null) return;
    await sendMessage(tenantId, activeChannelId, [
      { kind: "text", text },
    ]).catch(() => undefined);
    await loadMessages(activeChannelId);
  }

  const activeChannel =
    channelsState.kind === "ready"
      ? [...channelsState.channels, ...channelsState.chats].find(
          (channel) => channel.id === activeChannelId,
        )
      : undefined;

  return (
    <>
      <TopBar>
        <TopBarTitle
          {...subtitleProp(
            activeChannel !== undefined
              ? activeChannel.title || CHAT_STRINGS.unnamedChannel
              : undefined,
          )}
        >
          Chat
        </TopBarTitle>
        {activeChannelId !== null ? (
          <TopBarActions>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setInviteDialogOpen(true)}
            >
              <UserPlus />
              {CHAT_STRINGS.inviteAgentAction}
            </Button>
          </TopBarActions>
        ) : null}
      </TopBar>
      <div className="chat-workspace">
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
        ) : (
          <ChatSidebar
            channels={channelsState.channels}
            chats={channelsState.chats}
            activeChannelId={activeChannelId}
            onSelect={(channel) => setActiveChannelId(channel.id)}
            onNewChannel={() => setDialogOpen(true)}
          />
        )}
        <div className="chat-main">
          {activeChannelId === null ? (
            <EmptyState
              icon={<MessageSquare />}
              title={CHAT_STRINGS.noChatSelectedTitle}
              description={CHAT_STRINGS.noChatSelectedDescription}
            />
          ) : messagesState.kind === "loading" ? (
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
              <ChannelTimeline
                items={messagesState.items}
                participants={activeChannel?.participants ?? []}
              />
              <Composer
                agents={mentionCandidatesFromParticipants(
                  activeChannel?.participants ?? [],
                )}
                onSend={(text) => void handleSend(text)}
              />
            </>
          )}
        </div>
      </div>
      <NewChannelDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreate={(input) => void handleCreateChannel(input)}
        submitting={creating}
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
  return (
    <>
      <TopBar>
        <TopBarTitle>Chat</TopBarTitle>
      </TopBar>
      {children}
    </>
  );
}

export function ChatWorkspace({
  tenant,
}: {
  readonly tenant: TenantResolution;
}) {
  switch (tenant.kind) {
    case "ready":
      return <ChatWorkspaceInner tenantId={tenant.tenantId} />;
    case "empty":
      return (
        <ChatWorkspaceFrame>
          <EmptyState
            icon={<MessageSquare />}
            title={CHAT_STRINGS.noChannelsTitle}
            description="This account is not a member of any bench yet, so there is nowhere to chat."
          />
        </ChatWorkspaceFrame>
      );
    case "loading":
      return (
        <ChatWorkspaceFrame>
          <Skeleton className="query-skeleton" />
        </ChatWorkspaceFrame>
      );
    case "unauthenticated":
      return (
        <ChatWorkspaceFrame>
          <EmptyState
            icon={<Lock />}
            title="Sign in required"
            description="Your session has ended. Reload the page to sign in again."
          />
        </ChatWorkspaceFrame>
      );
    case "error":
      return (
        <ChatWorkspaceFrame>
          <EmptyState
            icon={<CircleAlert />}
            title="Couldn't load your benches"
            description={tenant.message}
          />
        </ChatWorkspaceFrame>
      );
  }
}
