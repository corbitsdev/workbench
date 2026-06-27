import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import {
  ChatLauncher,
  DockedChatBar,
  DOCKED_BAR_HEIGHT,
  FloatingChat,
  type ChatDockState,
} from "@workbench/chat";
import { useChatLauncher } from "../lib/chat-launcher-context";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { useMyraSession } from "../hooks/use-myra-session";
import {
  resolveActiveThread,
  useAutoTitleFirstMessage,
  useCreateMyraThread,
  useMyraThreads,
  writeLastActiveThreadId,
} from "../hooks/use-myra-threads";
import { takePendingFirstMessage } from "../lib/pending-first-message";
import { ExpandedChatOverlay, MyraChatSurface } from "./MyraChatSurface";
import { ThreadSwitcher } from "./ThreadSwitcher";

const DOCK_STATE_KEY = "myra-chat-dock-state";

function readDockState(): ChatDockState {
  try {
    const stored = localStorage.getItem(DOCK_STATE_KEY);
    if (stored === "docked" || stored === "floating") return stored;
  } catch {
    // localStorage unavailable
  }
  return "floating";
}

function writeDockState(state: ChatDockState): void {
  try {
    localStorage.setItem(DOCK_STATE_KEY, state);
  } catch {
    // localStorage unavailable
  }
}

/**
 * Global Myra quick-access: a floating/docked chat surface available on every
 * route except the full-page chat (`/` and `/chats/*`), where the page owns the
 * session. Defaults to the last-active thread and offers an in-place switcher.
 */
export function PersonalAgentChat() {
  const location = useLocation();
  const onChatRoute =
    location.pathname === "/" || location.pathname.startsWith("/chats");

  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dockState, setDockState] = useState<ChatDockState>(readDockState);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const { activeTenantId } = useActiveWorkbench();
  const { data: threads } = useMyraThreads();
  const createThread = useCreateMyraThread();

  const activeThread = resolveActiveThread(threads ?? [], selectedThreadId);
  const session = useMyraSession(
    activeThread?.instanceId ?? null,
    activeTenantId,
    !onChatRoute,
  );

  // Auto-title a still-default thread from its first message, exactly as the
  // full-page chat does — the dock is the surface most new threads start from.
  const maybeTitleFromFirstMessage = useAutoTitleFirstMessage(activeThread);

  const {
    hidden: launcherHidden,
    registerReconnect,
    pendingMessage,
    clearPendingMessage,
    pendingDockThreadId,
    clearPendingDockThread,
  } = useChatLauncher();

  useEffect(() => {
    registerReconnect(session.reconnect);
  }, [registerReconnect, session.reconnect]);

  // Deliver a message requested via "Open in Myra". Opening is immediate; the
  // send waits until the session is ready, then clears the pending message so it
  // is delivered exactly once.
  useEffect(() => {
    if (pendingMessage === null) return;
    setOpen(true);
    if (
      session.state.phase === "error" ||
      session.state.phase === "credential-error"
    ) {
      clearPendingMessage();
      return;
    }
    if (session.state.phase !== "ready") return;
    maybeTitleFromFirstMessage(pendingMessage);
    session.send(pendingMessage);
    clearPendingMessage();
    // session.send is recreated each render; depend on the phase that gates it.
  }, [pendingMessage, session.state.phase, clearPendingMessage]);

  const toggleDock = () => {
    setDockState((prev) => {
      const next = prev === "docked" ? "floating" : "docked";
      writeDockState(next);
      return next;
    });
  };

  const toggleExpand = () => setExpanded((prev) => !prev);

  const selectThread = (threadId: string) => {
    setSelectedThreadId(threadId);
    writeLastActiveThreadId(threadId);
  };

  const newThread = () => {
    createThread.mutate(undefined, {
      onSuccess: (thread) => selectThread(thread.id),
    });
  };

  // Deliver a first message seeded by another surface (e.g. the artifact panel
  // handing its thread to the dock before its own session finished launching).
  // Delete-on-read makes this safe even if another surface also tries.
  const deliveredRef = useRef<string | null>(null);
  useEffect(() => {
    if (session.state.phase !== "ready" || !activeThread) return;
    if (deliveredRef.current === activeThread.id) return;
    const pending = takePendingFirstMessage(activeThread.id);
    if (pending) {
      deliveredRef.current = activeThread.id;
      maybeTitleFromFirstMessage(pending);
      session.send(pending);
    }
    // session.send is recreated each render; gate on phase + thread id instead.
  }, [session.state.phase, activeThread]);

  // Consume a "Open in dock" handoff (e.g. from the artifact panel): bind to the
  // requested thread, switch to docked mode, open, then clear it once.
  useEffect(() => {
    if (pendingDockThreadId === null) return;
    selectThread(pendingDockThreadId);
    setDockState("docked");
    writeDockState("docked");
    setOpen(true);
    clearPendingDockThread();
    // selectThread is recreated each render; the pending id gates this.
  }, [pendingDockThreadId, clearPendingDockThread]);

  // The full-page chat owns the session on '/' and /chats routes; suppress the
  // launcher there so there is exactly one Myra surface on screen.
  if (onChatRoute) return null;

  const switcherBar = (
    <div className="flex shrink-0 items-center justify-between border-b border-border bg-surface px-3 py-1.5">
      <ThreadSwitcher
        threads={threads ?? []}
        activeThreadId={activeThread?.id ?? null}
        onSelect={selectThread}
        onNew={newThread}
        creating={createThread.isPending}
      />
    </div>
  );

  const panel = (
    <div className="flex h-full flex-col">
      {switcherBar}
      <div className="min-h-0 flex-1">
        <MyraChatSurface
          session={session}
          onUserSend={maybeTitleFromFirstMessage}
          dockState={dockState}
          onToggleDock={toggleDock}
          expanded={expanded}
          onToggleExpand={toggleExpand}
          onClose={() => setOpen(false)}
        />
      </div>
    </div>
  );

  // While expanded, the whole panel (thread switcher + surface) is lifted into a
  // single dismissible full-screen overlay; the inline dock/popup is not also
  // rendered, so no emptied chat is left stranded behind the overlay. The overlay
  // is always mounted so AnimatePresence can play its exit transition on collapse.
  const overlay = (
    <ExpandedChatOverlay open={expanded} onExit={toggleExpand}>
      {panel}
    </ExpandedChatOverlay>
  );

  if (dockState === "docked") {
    return (
      <>
        {!expanded && (
          <>
            {/* Spacer reserves height in the flex column so main content shrinks
                above the fixed overlay rather than being hidden behind it. */}
            <div
              aria-hidden
              style={{ height: DOCKED_BAR_HEIGHT + 18 }}
              className="shrink-0"
            />
            <DockedChatBar>{panel}</DockedChatBar>
          </>
        )}
        {overlay}
      </>
    );
  }

  return (
    <>
      {!launcherHidden && (
        <ChatLauncher onClick={() => setOpen((prev) => !prev)} open={open} />
      )}
      {!expanded && (
        <FloatingChat open={open} onClose={() => setOpen(false)}>
          {panel}
        </FloatingChat>
      )}
      {overlay}
    </>
  );
}
