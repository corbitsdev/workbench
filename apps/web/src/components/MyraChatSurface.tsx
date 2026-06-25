import {
  ChatPanel,
  type ChatAgentIdentity,
  type ChatDockState,
  type UIResponse,
} from "@workbench/chat";
import {
  friendlyToolSummary,
  summarizeToolCalls,
} from "@workbench/agents/browser";
import { useCompactToolActivity, useToolSummaryStyle } from "@workbench/ui";
import type { ToolCall } from "@workbench/chat";
import type { MyraSession } from "../hooks/use-myra-session";

const MYRA: ChatAgentIdentity = { name: "Myra", tagline: "Personal agent" };

// Myra's file tools are private working memory (MEMORY.md, SCRATCHPAD.md).
// Hide those tool-call lines from the thread so her self-management does not
// clutter the conversation.
const PRIVATE_FILE_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "search_files",
]);
const hideMyraSelfManagement = (call: { name: string }): boolean =>
  PRIVATE_FILE_TOOLS.has(call.name);

type MyraChatSurfaceProps = {
  session: MyraSession;
  /** Optional thread label shown as the agent tagline (multi-thread chat). */
  threadLabel?: string;
  /** Notified with the text whenever the user sends a message (for auto-title). */
  onUserSend?: (text: string) => void;
  dockState?: ChatDockState;
  onToggleDock?: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onClose?: () => void;
};

export function MyraChatSurface({
  session,
  threadLabel,
  onUserSend,
  dockState,
  onToggleDock,
  expanded,
  onToggleExpand,
  onClose,
}: MyraChatSurfaceProps) {
  const agent: ChatAgentIdentity = threadLabel
    ? { ...MYRA, tagline: threadLabel }
    : MYRA;
  const { compact: compactToolActivity } = useCompactToolActivity();
  const { style: toolSummaryStyle } = useToolSummaryStyle();
  const summarize = (calls: ToolCall[]) =>
    summarizeToolCalls(calls, toolSummaryStyle);

  const chrome = {
    agent,
    dockState,
    onToggleDock,
    expanded,
    onToggleExpand,
    onClose,
  };

  const { state } = session;

  if (state.phase === "loading") {
    return (
      <ChatPanel
        {...chrome}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
      />
    );
  }

  if (state.phase === "provisioning") {
    return (
      <ChatPanel
        {...chrome}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
        notice={<span>Setting up Myra for your workspace…</span>}
      />
    );
  }

  if (state.phase === "credential-error") {
    return (
      <ChatPanel
        {...chrome}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
        notice={
          <span>
            No API credential is set up for Myra. Ask your admin to finish
            workspace setup.
          </span>
        }
      />
    );
  }

  if (state.phase === "error") {
    return (
      <ChatPanel
        {...chrome}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
        notice={
          <span>
            Couldn't reach Myra.{" "}
            <button
              type="button"
              onClick={session.reconnect}
              className="text-orange underline"
            >
              Try again
            </button>
            .
          </span>
        }
      />
    );
  }

  const handleSend = (text: string) => {
    onUserSend?.(text);
    session.send(text);
  };
  const handleRespond = (response: UIResponse) => session.send(response.value);

  return (
    <ChatPanel
      {...chrome}
      messages={session.messages}
      onSend={handleSend}
      onRespond={handleRespond}
      activity={session.activity}
      onRate={session.onRate}
      getRating={session.getRating}
      hideToolCall={hideMyraSelfManagement}
      formatToolSummary={friendlyToolSummary}
      compactToolActivity={compactToolActivity}
      summarizeToolCalls={summarize}
    />
  );
}
