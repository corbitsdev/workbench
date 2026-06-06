import { createContext, useContext, useState } from 'react';

interface ChatLauncherContextValue {
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
}

const ChatLauncherContext = createContext<ChatLauncherContextValue>({
  hidden: false,
  setHidden: () => {},
});

export function ChatLauncherProvider({ children }: { children: React.ReactNode }) {
  const [hidden, setHidden] = useState(false);
  return <ChatLauncherContext value={{ hidden, setHidden }}>{children}</ChatLauncherContext>;
}

export function useChatLauncher() {
  return useContext(ChatLauncherContext);
}
