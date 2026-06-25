import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import {
  ChatLauncher,
  DockedChatBar,
  DOCKED_BAR_HEIGHT,
  FloatingChat,
  type ChatDockState,
} from '@workbench/chat';
import { useChatLauncher } from '../lib/chat-launcher-context';
import { useMyraSession } from '../hooks/use-myra-session';
import {
  resolveActiveThread,
  useCreateMyraThread,
  useMyraThreads,
  writeLastActiveThreadId,
} from '../hooks/use-myra-threads';
import { takePendingFirstMessage } from '../lib/pending-first-message';
import { MyraChatSurface } from './MyraChatSurface';
import { ThreadSwitcher } from './ThreadSwitcher';

const DOCK_STATE_KEY = 'myra-chat-dock-state';

function readDockState(): ChatDockState {
  try {
    const stored = localStorage.getItem(DOCK_STATE_KEY);
    if (stored === 'docked' || stored === 'floating') return stored;
  } catch {
    // localStorage unavailable
  }
  return 'floating';
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
  const onChatRoute = location.pathname === '/' || location.pathname.startsWith('/chats');

  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dockState, setDockState] = useState<ChatDockState>(readDockState);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const { data: threads } = useMyraThreads();
  const createThread = useCreateMyraThread();

  const activeThread = resolveActiveThread(threads ?? [], selectedThreadId);
  const session = useMyraSession(activeThread?.instanceId ?? null, !onChatRoute);

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
    if (session.state.phase === 'error' || session.state.phase === 'credential-error') {
      clearPendingMessage();
      return;
    }
    if (session.state.phase !== 'ready') return;
    session.send(pendingMessage);
    clearPendingMessage();
    // session.send is recreated each render; depend on the phase that gates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMessage, session.state.phase, clearPendingMessage]);

  const toggleDock = () => {
    setDockState((prev) => {
      const next = prev === 'docked' ? 'floating' : 'docked';
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
    if (session.state.phase !== 'ready' || !activeThread) return;
    if (deliveredRef.current === activeThread.id) return;
    const pending = takePendingFirstMessage(activeThread.id);
    if (pending) {
      deliveredRef.current = activeThread.id;
      session.send(pending);
    }
    // session.send is recreated each render; gate on phase + thread id instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.state.phase, activeThread]);

  // Consume a "Open in dock" handoff (e.g. from the artifact panel): bind to the
  // requested thread, switch to docked mode, open, then clear it once.
  useEffect(() => {
    if (pendingDockThreadId === null) return;
    selectThread(pendingDockThreadId);
    setDockState('docked');
    writeDockState('docked');
    setOpen(true);
    clearPendingDockThread();
    // selectThread is recreated each render; the pending id gates this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          dockState={dockState}
          onToggleDock={toggleDock}
          expanded={expanded}
          onToggleExpand={toggleExpand}
          onClose={() => setOpen(false)}
        />
      </div>
    </div>
  );

  if (dockState === 'docked') {
    return (
      <>
        {/* Spacer reserves height in the flex column so main content shrinks
            above the fixed overlay rather than being hidden behind it. */}
        <div aria-hidden style={{ height: DOCKED_BAR_HEIGHT + 18 }} className="shrink-0" />
        <DockedChatBar>{panel}</DockedChatBar>
      </>
    );
  }

  return (
    <>
      {!launcherHidden && <ChatLauncher onClick={() => setOpen((prev) => !prev)} open={open} />}
      <FloatingChat open={open} expanded={expanded} onClose={() => setOpen(false)}>
        {panel}
      </FloatingChat>
    </>
  );
}
