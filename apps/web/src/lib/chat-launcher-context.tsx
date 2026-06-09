import { createContext, useContext, useRef, useState } from 'react';

interface ChatLauncherContextValue {
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
  // Called by WorkbenchHome after Myra is provisioned so PersonalAgentChat
  // reconnects without polling.
  notifyProvisioned: () => void;
  // PersonalAgentChat registers its reconnect callback here on mount.
  registerReconnect: (fn: () => void) => void;
}

const ChatLauncherContext = createContext<ChatLauncherContextValue>({
  hidden: false,
  setHidden: () => {},
  notifyProvisioned: () => {},
  registerReconnect: () => {},
});

export function ChatLauncherProvider({ children }: { children: React.ReactNode }) {
  const [hidden, setHidden] = useState(false);
  const reconnectRef = useRef<(() => void) | null>(null);

  const registerReconnect = (fn: () => void) => {
    reconnectRef.current = fn;
  };

  const notifyProvisioned = () => {
    reconnectRef.current?.();
  };

  return (
    <ChatLauncherContext value={{ hidden, setHidden, notifyProvisioned, registerReconnect }}>
      {children}
    </ChatLauncherContext>
  );
}

export function useChatLauncher() {
  return useContext(ChatLauncherContext);
}
