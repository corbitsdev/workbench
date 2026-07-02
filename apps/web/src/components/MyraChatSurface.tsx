import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Minimize2 } from "lucide-react";
import {
  ChatPanel,
  type ChatAgentIdentity,
  type ChatDockState,
  type UIResponse,
  type PendingAttachment,
} from "@workbench/chat";
import {
  friendlyToolSummary,
  summarizeToolCalls,
  attachmentPolicyForAgent,
} from "@workbench/agents/browser";
import { useCompactToolActivity, useToolSummaryStyle } from "@workbench/ui";
import type { ToolCall } from "@workbench/chat";
import {
  activeContextToRef,
  projectActiveContext,
  type ActiveContext,
  type ActiveContextRef,
} from "@workbench/shared";
import type { MyraSession } from "../hooks/use-myra-session";
import { useActiveContext } from "../lib/active-context-store";
import { useAttachShortcut } from "../hooks/use-attach-shortcut";
import { ActiveContextPills } from "./ActiveContextPills";

/**
 * Near-full-screen overlay wrapping the whole chat panel while expanded so the
 * thread switcher rides along into fullscreen. Unlike the
 * dock's plain expand, this is always dismissible: Escape and the visible
 * minimize button both collapse back (via `onExit`) — they never close the
 * chat. Body scroll is locked while open and restored on exit so the
 * underlying page is never left trapped.
 */
export function ExpandedChatOverlay({
  children,
  open,
  onExit,
}: {
  children: ReactNode;
  open: boolean;
  onExit: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onExit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onExit]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Expanded chat"
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
          className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.4)]"
        >
          <div className="flex shrink-0 items-center justify-end border-b border-border px-2 py-1.5">
            <button
              type="button"
              onClick={onExit}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-2 hover:bg-surface-2 hover:text-text cursor-pointer transition-[transform,background-color,color] duration-150 ease-out active:scale-[0.97]"
            >
              <Minimize2 className="h-3.5 w-3.5" />
              Minimize
            </button>
          </div>
          <div className="min-h-0 flex-1">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

const MYRA: ChatAgentIdentity = { name: "Myra", tagline: "Personal agent" };

// Myra runs on Kimi via the openai-compatible adapter, which reads images but
// not documents; the gate resolves that to images-only. Undefined (attachments
// hidden) if the capability ever resolves to none.
const MYRA_ATTACHMENT_POLICY = attachmentPolicyForAgent(MYRA.name);

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

  const activeContext = useActiveContext();
  const [attached, setAttached] = useState<ActiveContext[]>([]);

  const attachCurrent = useCallback((): boolean => {
    if (!activeContext) return false;
    setAttached((prev) =>
      prev.some(
        (c) => c.kind === activeContext.kind && c.id === activeContext.id,
      )
        ? prev
        : [...prev, activeContext],
    );
    return true;
  }, [activeContext]);
  useAttachShortcut(attachCurrent);

  const removeAttached = (ref: ActiveContextRef) =>
    setAttached((prev) =>
      prev.filter((c) => !(c.kind === ref.kind && c.id === ref.id)),
    );

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

  // Attachments are projected to a compact lead-in and composed inline into the
  // message. Inline (not a first-class Interchange attachment) because Myra's
  // DeepSeek/openai-compatible harness does not ingest document attachment
  // ContentBlocks (CL-2495 spike). Cleared once the send is dispatched.
  const handleSend = (text: string, attachments?: PendingAttachment[]) => {
    onUserSend?.(text);
    const composed =
      attached.length === 0
        ? text
        : `${attached
            .map((c) => projectActiveContext(c).leadIn)
            .join("\n\n")}\n\n${text}`;
    if (attached.length > 0) setAttached([]);
    return session.send(composed, attachments);
  };
  const handleRespond = (response: UIResponse) => session.send(response.value);

  const inputAccessory =
    attached.length > 0 ? (
      <ActiveContextPills
        attached={attached.map(activeContextToRef)}
        onRemove={removeAttached}
      />
    ) : null;

  return (
    <ChatPanel
      {...chrome}
      messages={session.messages}
      onSend={handleSend}
      onRespond={handleRespond}
      inputAccessory={inputAccessory}
      {...(MYRA_ATTACHMENT_POLICY !== undefined
        ? { attachmentPolicy: MYRA_ATTACHMENT_POLICY }
        : {})}
      activity={session.activity}
      onRate={session.onRate}
      getRating={session.getRating}
      {...(session.resolveAttachmentUrl !== undefined
        ? { resolveAttachmentUrl: session.resolveAttachmentUrl }
        : {})}
      hideToolCall={hideMyraSelfManagement}
      formatToolSummary={friendlyToolSummary}
      compactToolActivity={compactToolActivity}
      summarizeToolCalls={summarize}
    />
  );
}
