import { useState } from 'react';
import {
  ChatLauncher,
  ChatPanel,
  DockedChat,
  FloatingChat,
  type ChatAgentIdentity,
  type ChatDockState,
  type ChatMessage,
} from '@workbench/chat';

const ADA: ChatAgentIdentity = { name: 'Ada', tagline: 'Personal agent' };

const WELCOME: ChatMessage = {
  id: 'welcome',
  role: 'agent',
  content: "Hi, I'm Ada. Ask me anything about your workbench.",
  createdAt: new Date(0).toISOString(),
};

/**
 * App-side mount for the @workbench/chat widget.
 *
 * NOTE: This is a SHELL wiring for CL-1256. The `handleSend` adapter below is a
 * PLACEHOLDER local-echo stub — it just echoes the user's message back as Ada.
 * The real transport (POST /agents/instances/:paId/mail + outbox polling) is
 * CL-991 and must replace `handleSend` without touching the @workbench/chat
 * package, which stays stateless and transport-free.
 */
export function PersonalAgentChat() {
  const [open, setOpen] = useState(false);
  const [dockState, setDockState] = useState<ChatDockState>('floating');
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);

  // PLACEHOLDER transport adapter for CL-991. Local echo only.
  const handleSend = (text: string) => {
    const now = Date.now();
    const userMessage: ChatMessage = {
      id: `u-${now}`,
      role: 'user',
      content: text,
      createdAt: new Date(now).toISOString(),
      status: 'sent',
    };
    const echo: ChatMessage = {
      id: `a-${now}`,
      role: 'agent',
      content: `(stub) You said: ${text}`,
      createdAt: new Date(now + 1).toISOString(),
    };
    setMessages((prev) => [...prev, userMessage, echo]);
  };

  const toggleDock = () => {
    setDockState((prev) => (prev === 'docked' ? 'floating' : 'docked'));
  };

  const panel = (
    <ChatPanel
      agent={ADA}
      messages={messages}
      onSend={handleSend}
      dockState={dockState}
      onToggleDock={toggleDock}
      onClose={() => setOpen(false)}
    />
  );

  if (dockState === 'docked') {
    return <DockedChat side="right">{panel}</DockedChat>;
  }

  return (
    <>
      <ChatLauncher onClick={() => setOpen((prev) => !prev)} open={open} />
      <FloatingChat open={open}>{panel}</FloatingChat>
    </>
  );
}
