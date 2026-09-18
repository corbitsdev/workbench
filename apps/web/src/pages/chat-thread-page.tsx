// A chat: one person, one agent, one mail thread. `/chats/new` composes a
// first message (agent picked in the select, or by @tagging one in the
// message itself); `/chats/:id` is the transcript plus a reply box.

import { Button, EmptyState, PageShell, Select } from "@corbits/react-ui";
import { WarningCircle } from "@/lib/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { Composer } from "@/chat/composer";
import { Markdown } from "@/chat/markdown";
import {
  agentFromMention,
  agentInitials,
  listChatAgents,
  readChat,
  replyInChat,
  startChat,
  subscribeToInbox,
  type ChatAgent,
} from "@/chat/threads-api";
import { MYRA_SOURCE_CONFIG } from "../myra-source";
import { useBench } from "../bench-context";
import { chatIdFromPath, chatKeys, chatPath, NEW_CHAT_PATH } from "../chat-path";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function NewChat({
  tenantId,
  navigate,
}: {
  readonly tenantId: string;
  readonly navigate: (to: string) => void;
}) {
  const queryClient = useQueryClient();
  const agentsQuery = useQuery({
    queryKey: chatKeys.agents(tenantId),
    queryFn: () => listChatAgents(tenantId),
    // Keep polling while the chosen agent has no live run yet, so the
    // composer unlocks itself once a redeploy finishes.
    refetchInterval: (query) => {
      const agentsData = query.state.data;
      if (agentsData === undefined) return false;
      const defaultAgent = agentsData.find(
        (agent) => agent.name === MYRA_SOURCE_CONFIG.displayName,
      );
      return (defaultAgent ?? agentsData[0])?.liveAddress === null ? 3000 : false;
    },
  });
  const agents = useMemo<readonly ChatAgent[]>(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const [selected, setSelected] = useState<string>("");

  const start = useMutation({
    mutationFn: ({ agent, text }: { readonly agent: ChatAgent; readonly text: string }) =>
      startChat(tenantId, agent, text),
    onSuccess: (chatId) => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.scope(tenantId) });
      navigate(chatPath(chatId));
    },
  });

  const defaultAgent = agents.find((agent) => agent.name === MYRA_SOURCE_CONFIG.displayName);
  const chosen = agents.find((agent) => agent.id === selected) ?? defaultAgent ?? agents[0];
  const error: unknown = start.error ?? agentsQuery.error;
  const isLive = chosen?.liveAddress !== null && chosen?.liveAddress !== undefined;

  return (
    <PageShell width="prose" className="page-fill">
      <h1 className="chat-thread-title">New chat</h1>
      <label className="chat-agent-picker">
        <span>Agent</span>
        <Select
          value={chosen?.id ?? ""}
          aria-label="Agent"
          onChange={(event) => setSelected(event.target.value)}
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </Select>
      </label>
      {agentsQuery.isSuccess && agents.length === 0 ? (
        <p className="chat-thread-error">
          No agent is deployed yet, so there is nobody to chat with.
        </p>
      ) : null}
      {error === null || error === undefined ? null : (
        <p className="chat-thread-error">{errorText(error)}</p>
      )}
      <Composer
        placeholder={
          isLive
            ? `Message ${chosen?.name ?? MYRA_SOURCE_CONFIG.displayName}`
            : `${chosen?.name ?? MYRA_SOURCE_CONFIG.displayName} is starting…`
        }
        busy={start.isPending}
        disabled={!isLive}
        onSend={(text) => {
          const agent = agentFromMention(text, agents) ?? chosen;
          if (agent === undefined) return;
          start.mutate({ agent, text });
        }}
      />
    </PageShell>
  );
}

function ChatTranscript({
  tenantId,
  chatId,
  navigate,
}: {
  readonly tenantId: string;
  readonly chatId: string;
  readonly navigate: (to: string) => void;
}) {
  const queryClient = useQueryClient();
  const chatQuery = useQuery({
    queryKey: chatKeys.one(tenantId, chatId),
    queryFn: () => readChat(tenantId, chatId),
    // The agent may be mid-redeploy with no live run; keep polling until
    // one comes up so the composer unlocks on its own.
    refetchInterval: (query) => (query.state.data?.agent.liveAddress === null ? 3000 : false),
  });
  const chat = chatQuery.data;

  // The inbox stream is the only signal that an agent has answered; it
  // carries no chat identity, so it invalidates rather than patches.
  useEffect(
    () =>
      subscribeToInbox(tenantId, () => {
        void queryClient.invalidateQueries({ queryKey: chatKeys.scope(tenantId) });
      }),
    [tenantId, queryClient],
  );

  const reply = useMutation({
    mutationFn: (text: string) => {
      if (chat === undefined) throw new Error("no chat to reply in");
      return replyInChat(tenantId, chat, text);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.scope(tenantId) }),
  });

  if (chatQuery.isError && chat === undefined) {
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<WarningCircle />}
          title="Couldn't open that chat"
          description={errorText(chatQuery.error)}
          action={
            <Button variant="outline" onClick={() => navigate(NEW_CHAT_PATH)}>
              Start a new chat
            </Button>
          }
        />
      </PageShell>
    );
  }
  if (chat === undefined) return <PageShell width="prose" className="page-fill" />;

  return (
    <PageShell width="prose" className="page-fill">
      <h1 className="chat-thread-title">{chat.title}</h1>
      <div className="chat-thread-messages">
        {chat.messages.map((message) => (
          <div key={message.id} className="chat-thread-message" data-author={message.author}>
            <span className="shell-ch-avatar">
              <span className="shell-ch-initial" aria-hidden="true">
                {message.author === "me" ? "You" : agentInitials(message.authorName)}
              </span>
            </span>
            <div className="chat-thread-body">
              <Markdown text={message.body} />
            </div>
          </div>
        ))}
      </div>
      {reply.error === null ? null : <p className="chat-thread-error">{errorText(reply.error)}</p>}
      <Composer
        placeholder={
          chat.agent.liveAddress === null
            ? `${chat.agentName} is starting…`
            : `Message ${chat.agentName}`
        }
        busy={reply.isPending}
        disabled={chat.agent.liveAddress === null}
        onSend={(text) => reply.mutate(text)}
      />
    </PageShell>
  );
}

export function ChatThreadRoute({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const chatId = chatIdFromPath(path);

  if (selectedTenantId === null) {
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<WarningCircle />}
          title="No workbench selected"
          description="Pick a workbench before starting a chat."
        />
      </PageShell>
    );
  }
  if (chatId === null) return <NewChat tenantId={selectedTenantId} navigate={navigate} />;
  return <ChatTranscript tenantId={selectedTenantId} chatId={chatId} navigate={navigate} />;
}
