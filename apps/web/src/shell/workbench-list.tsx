// Two sections, in this order and never mixed: Workbenches above Chats.
// Agent membership is a workbench concept; a chat has exactly one agent.

import { EmptyState, Input, Skeleton } from "@corbits/react-ui";
import { Check, Hash, MagnifyingGlass } from "@/lib/icons";
import { useState } from "react";

import { IdentityAvatar } from "@/chat/avatar";
import { isChatReplyReady, type ChatSummary } from "@/chat/threads-api";

import { useBench } from "../bench-context";
import { chatPath, CHATS_PATH_PREFIX } from "../chat-path";
import { workbenchIdFromPath, workbenchPath } from "../workbench-path";
import type { HubTenant } from "../needs-converge";
import { useSidebarSections } from "./sidebar-sections";

/** How many chats the section shows before "See all" expands it. */
const COLLAPSED_CHAT_COUNT = 5;

export const SIDEBAR_EMPTY_COPY = "No conversations yet";

function matches(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle);
}

function SectionLabel({ children }: { readonly children: string }) {
  return <div className="shell-panel-section-label">{children}</div>;
}

function WorkbenchRow({
  tenant,
  active,
  onSelect,
}: {
  readonly tenant: HubTenant;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="shell-ch-row"
      aria-current={active ? "true" : undefined}
      data-active={active ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="shell-ch-avatar">
        <span className="shell-ch-initial" aria-hidden="true">
          <Hash />
        </span>
      </span>
      <span className="shell-ch-meta">
        <span className="shell-ch-name-row">
          <span className="shell-ch-name">{tenant.name}</span>
        </span>
      </span>
    </button>
  );
}

function ChatRow({
  chat,
  active,
  onSelect,
}: {
  readonly chat: ChatSummary;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  // A chat is reply-ready once its newest turn is an unseen agent reply;
  // opening the chat (readChat/markChatSeen) clears it.
  const replyReady = !active && isChatReplyReady(chat);
  return (
    <button
      type="button"
      className="shell-ch-row"
      aria-current={active ? "true" : undefined}
      data-active={active ? "true" : undefined}
      data-unread={replyReady ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="shell-ch-avatar" data-live={replyReady ? "reply-ready" : undefined}>
        <IdentityAvatar kind="agent" name={chat.agentName} principalId={chat.id} />
        {replyReady ? (
          <span className="shell-ch-completion" aria-hidden="true" title="Reply ready">
            <Check aria-hidden="true" />
          </span>
        ) : null}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {replyReady ? "Reply ready" : ""}
        </span>
      </span>
      <span className="shell-ch-meta">
        <span className="shell-ch-name-row">
          <span className="shell-ch-name">{chat.title}</span>
        </span>
        {chat.preview === "" ? null : <span className="shell-ch-preview">{chat.preview}</span>}
      </span>
    </button>
  );
}

export function WorkbenchList({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const sections = useSidebarSections(selectedTenantId);
  const [query, setQuery] = useState("");
  const [showAllChats, setShowAllChats] = useState(false);

  if (sections.kind === "loading") {
    return (
      <div className="shell-activity-skeleton-rows" aria-hidden="true">
        <Skeleton className="shell-activity-skeleton-row" />
        <Skeleton className="shell-activity-skeleton-row" />
        <Skeleton className="shell-activity-skeleton-row" />
      </div>
    );
  }
  if (sections.kind === "error") {
    return (
      <EmptyState
        icon={<Hash />}
        title="Couldn't load your conversations"
        description={sections.message}
      />
    );
  }

  const needle = query.trim().toLowerCase();
  const workbenches = sections.workbenches.filter(
    (tenant) => needle === "" || matches(tenant.name, needle),
  );
  const chats = sections.chats.filter(
    (chat) => needle === "" || matches(chat.title, needle) || matches(chat.agentName, needle),
  );
  const visibleChats = showAllChats ? chats : chats.slice(0, COLLAPSED_CHAT_COUNT);
  const activeWorkbenchId = workbenchIdFromPath(path);
  const activeChatId = path.startsWith(`${CHATS_PATH_PREFIX}/`)
    ? path.slice(CHATS_PATH_PREFIX.length + 1)
    : null;

  return (
    <div className="panel-stack" aria-label="Workbenches and chats">
      <label className="shell-panel-search">
        <MagnifyingGlass aria-hidden="true" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search…"
          aria-label="Search workbenches and chats"
        />
      </label>

      {workbenches.length + chats.length === 0 ? (
        <p className="shell-panel-list-empty">{SIDEBAR_EMPTY_COPY}</p>
      ) : null}

      {workbenches.length === 0 ? null : (
        <div className="panel-stack-group">
          <SectionLabel>Workbenches</SectionLabel>
          {workbenches.map((tenant) => (
            <WorkbenchRow
              key={tenant.id}
              tenant={tenant}
              active={tenant.id === activeWorkbenchId}
              onSelect={() => onNavigate(workbenchPath(tenant.id))}
            />
          ))}
        </div>
      )}

      {chats.length === 0 ? null : (
        <div className="panel-stack-group">
          <SectionLabel>Chats</SectionLabel>
          {visibleChats.map((chat) => (
            <ChatRow
              key={chat.id}
              chat={chat}
              active={chat.id === activeChatId}
              onSelect={() => onNavigate(chatPath(chat.id))}
            />
          ))}
          {chats.length > visibleChats.length || showAllChats ? (
            <button
              type="button"
              className="shell-panel-see-all"
              onClick={() => setShowAllChats((shown) => !shown)}
            >
              {showAllChats ? "Show fewer" : `See all ${String(chats.length)}`}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
