// Orchestrates the whole chat surface: resolves which bench (tenant) this
// account chats in, loads its channels and deployed agents, and wires the
// sidebar, timeline, and composer together for whichever channel is
// selected. The chat API has no tenant switcher of its own yet — like the
// onboarding flow's personal bench, this uses the account's first bench
// membership, from the same `/api/me/principals` call the Home and Settings
// pages already use.

import {
  Button,
  EmptyState,
  Skeleton,
  TopBar,
  TopBarTitle,
} from "@corbits/react-ui";
import { CircleAlert, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { PrincipalsSchema, useAPIQuery } from "../api";
import { subtitleProp } from "../optional-props";
import { QueryView } from "../query-view";
import {
  createChannel,
  deploymentDisplayName,
  listChannels,
  listDeployedAgents,
  listMessages,
  putReadState,
  sendMessage,
  channelStreamUrl,
} from "./api";
import type { Channel, ChannelKind, MessageItem } from "./api";
import { Composer } from "./composer";
import type { MentionCandidate } from "./mentions";
import { NewChannelDialog } from "./new-channel-dialog";
import { ChatSidebar } from "./sidebar";
import { CHAT_STRINGS } from "./strings";
import { ChannelTimeline } from "./timeline";
import { useChannelStream } from "./use-channel-stream";

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

function useAgentMentions(tenantId: string): readonly MentionCandidate[] {
  const [agents, setAgents] = useState<readonly MentionCandidate[]>([]);

  useEffect(() => {
    let cancelled = false;
    void listDeployedAgents(tenantId)
      .then((deployments) => {
        if (cancelled) return;
        setAgents(
          deployments.map((deployment) => ({
            id: deployment.id,
            name: deploymentDisplayName(deployment),
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  return agents;
}

function ChatWorkspaceInner({ tenantId }: { readonly tenantId: string }) {
  const [channelsRefresh, setChannelsRefresh] = useState(0);
  const { state: channelsState, reload: reloadChannels } = useChannelLists(
    tenantId,
    channelsRefresh,
  );
  const agents = useAgentMentions(tenantId);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [messagesState, setMessagesState] = useState<MessagesState>({
    kind: "loading",
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);

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
    if (activeChannelId !== null) void loadMessages(activeChannelId);
  }, [activeChannelId, loadMessages]);

  useChannelStream(
    activeChannelId !== null ? channelStreamUrl(tenantId, activeChannelId) : "",
    () => {
      if (activeChannelId !== null) void loadMessages(activeChannelId);
    },
    () => {
      if (activeChannelId !== null) void loadMessages(activeChannelId);
    },
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
              <ChannelTimeline items={messagesState.items} />
              <Composer
                agents={agents}
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
    </>
  );
}

export function ChatWorkspace() {
  const principals = useAPIQuery("/api/me/principals", PrincipalsSchema);
  if (principals.kind === "ready") {
    const tenantId = principals.data.data[0]?.tenantId;
    if (tenantId !== undefined) {
      return <ChatWorkspaceInner tenantId={tenantId} />;
    }
    return (
      <>
        <TopBar>
          <TopBarTitle>Chat</TopBarTitle>
        </TopBar>
        <EmptyState
          icon={<MessageSquare />}
          title={CHAT_STRINGS.noChannelsTitle}
          description="This account is not a member of any bench yet, so there is nowhere to chat."
        />
      </>
    );
  }
  return (
    <>
      <TopBar>
        <TopBarTitle>Chat</TopBarTitle>
      </TopBar>
      <QueryView query={principals} label="your benches">
        {() => null}
      </QueryView>
    </>
  );
}
