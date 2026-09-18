// A chat: one person, one agent, one mail thread. `/chats/new` composes a
// first message (agent picked in the select, or by @tagging one in the
// message itself); `/chats/:id` is the transcript plus a reply box.

import { Button, EmptyState, PageShell, Select, Textarea } from "@corbits/react-ui";
import { WarningCircle } from "@/lib/icons";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  type ChatThread,
} from "@/chat/threads-api";
import { MYRA_SOURCE_CONFIG } from "../myra-source";
import { useBench } from "../bench-context";
import { chatIdFromPath, chatPath } from "../chat-path";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function useChatAgents(tenantId: string | null): readonly ChatAgent[] {
  const [agents, setAgents] = useState<readonly ChatAgent[]>([]);
  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    void listChatAgents(tenantId).then(
      (rows) => {
        if (!cancelled) setAgents(rows);
      },
      () => {
        if (!cancelled) setAgents([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tenantId]);
  return agents;
}

function Composer({
  placeholder,
  busy,
  onSend,
}: {
  readonly placeholder: string;
  readonly busy: boolean;
  readonly onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const send = () => {
    const trimmed = text.trim();
    if (trimmed === "" || busy) return;
    setText("");
    onSend(trimmed);
  };
  return (
    <div className="chat-composer">
      <Textarea
        value={text}
        rows={3}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      <Button variant="primary" disabled={busy || text.trim() === ""} onClick={send}>
        {busy ? "Sending…" : "Send"}
      </Button>
    </div>
  );
}

function NewChat({
  tenantId,
  navigate,
}: {
  readonly tenantId: string;
  readonly navigate: (to: string) => void;
}) {
  const agents = useChatAgents(tenantId);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultAgent = useMemo(
    () => agents.find((agent) => agent.name === MYRA_SOURCE_CONFIG.displayName) ?? agents[0],
    [agents],
  );
  const chosen = agents.find((agent) => agent.runId === selected) ?? defaultAgent;

  const send = (text: string) => {
    const agent = agentFromMention(text, agents) ?? chosen;
    if (agent === undefined) {
      setError("No agent is deployed yet, so there is nobody to chat with.");
      return;
    }
    setBusy(true);
    setError(null);
    void startChat(tenantId, agent, text).then(
      (chatId) => navigate(chatPath(chatId)),
      (cause: unknown) => {
        setBusy(false);
        setError(errorText(cause));
      },
    );
  };

  return (
    <PageShell width="prose" className="page-fill">
      <h1 className="chat-thread-title">New chat</h1>
      <label className="chat-agent-picker">
        <span>Agent</span>
        <Select
          value={chosen?.runId ?? ""}
          aria-label="Agent"
          onChange={(event) => setSelected(event.target.value)}
        >
          {agents.map((agent) => (
            <option key={agent.runId} value={agent.runId}>
              {agent.name}
            </option>
          ))}
        </Select>
      </label>
      {error === null ? null : <p className="chat-thread-error">{error}</p>}
      <Composer placeholder="Message your agent — or @tag one" busy={busy} onSend={send} />
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
  const [chat, setChat] = useState<ChatThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void readChat(tenantId, chatId).then(
      (loaded) => {
        setChat(loaded);
        setError(null);
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  }, [tenantId, chatId]);

  useEffect(load, [load]);

  // A local chat becomes a real mail thread the moment the agent answers,
  // so the inbox stream is also this page's cue to re-address itself.
  useEffect(
    () =>
      subscribeToInbox(tenantId, () => {
        load();
      }),
    [tenantId, load],
  );

  const send = (text: string) => {
    if (chat === null) return;
    setBusy(true);
    void replyInChat(tenantId, chat, text).then(
      () => {
        setBusy(false);
        load();
      },
      (cause: unknown) => {
        setBusy(false);
        setError(errorText(cause));
      },
    );
  };

  if (error !== null && chat === null) {
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<WarningCircle />}
          title="Couldn't open that chat"
          description={error}
          action={
            <Button variant="outline" onClick={() => navigate("/chats/new")}>
              Start a new chat
            </Button>
          }
        />
      </PageShell>
    );
  }
  if (chat === null) return <PageShell width="prose" className="page-fill" />;

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
      {error === null ? null : <p className="chat-thread-error">{error}</p>}
      <Composer placeholder={`Reply to ${chat.agentName}`} busy={busy} onSend={send} />
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
