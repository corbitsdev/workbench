import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";

interface ChatLauncherContextValue {
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
  // Called by WorkbenchHome after Myra is provisioned so PersonalAgentChat
  // reconnects without polling.
  notifyProvisioned: () => void;
  // PersonalAgentChat registers its reconnect callback here on mount.
  registerReconnect: (fn: () => void) => void;
  // Open the Myra chat seeded with a message (e.g. "Open in Myra" from an
  // artifact). PersonalAgentChat consumes the pending message once its session
  // is ready, then calls clearPendingMessage.
  pendingMessage: string | null;
  openWithMessage: (message: string) => void;
  clearPendingMessage: () => void;
  // Hand an existing thread to the global docked chat (e.g. "Open in dock" from
  // the artifact panel). PersonalAgentChat selects the thread, switches to
  // docked mode, and opens, then calls clearPendingDockThread.
  pendingDockThreadId: string | null;
  openThreadInDock: (threadId: string) => void;
  clearPendingDockThread: () => void;
}

export const ChatLauncherContext = createContext<ChatLauncherContextValue>({
  hidden: false,
  setHidden: () => {},
  notifyProvisioned: () => {},
  registerReconnect: () => {},
  pendingMessage: null,
  openWithMessage: () => {},
  clearPendingMessage: () => {},
  pendingDockThreadId: null,
  openThreadInDock: () => {},
  clearPendingDockThread: () => {},
});

export function ChatLauncherProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [hidden, setHidden] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [pendingDockThreadId, setPendingDockThreadId] = useState<string | null>(
    null,
  );
  const reconnectRef = useRef<(() => void) | null>(null);

  const registerReconnect = useCallback((fn: () => void) => {
    reconnectRef.current = fn;
  }, []);

  const notifyProvisioned = useCallback(() => {
    reconnectRef.current?.();
  }, []);

  const openWithMessage = useCallback((message: string) => {
    setHidden(false);
    setPendingMessage(message);
  }, []);

  const clearPendingMessage = useCallback(() => {
    setPendingMessage(null);
  }, []);

  const openThreadInDock = useCallback((threadId: string) => {
    setHidden(false);
    setPendingDockThreadId(threadId);
  }, []);

  const clearPendingDockThread = useCallback(() => {
    setPendingDockThreadId(null);
  }, []);

  return (
    <ChatLauncherContext
      value={{
        hidden,
        setHidden,
        notifyProvisioned,
        registerReconnect,
        pendingMessage,
        openWithMessage,
        clearPendingMessage,
        pendingDockThreadId,
        openThreadInDock,
        clearPendingDockThread,
      }}
    >
      {children}
    </ChatLauncherContext>
  );
}

export function useChatLauncher() {
  return useContext(ChatLauncherContext);
}
