import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  createBrowserTransport,
  createInstanceSession,
  type InstanceSession,
} from '@intx/hub-client';
import { convertInstanceEvents } from '@workbench/agents';
import {
  ChatLauncher,
  ChatPanel,
  DockedChat,
  FloatingChat,
  type ChatAgentIdentity,
  type ChatDockState,
  type ChatMessage,
} from '@workbench/chat';
import { getMe } from '../lib/hub-api';

const MYRA: ChatAgentIdentity = { name: 'Myra', tagline: 'Personal agent' };

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

type SessionState =
  | { phase: 'loading' }
  | { phase: 'provisioning' }
  | { phase: 'ready'; session: InstanceSession }
  | { phase: 'error'; message: string };

export function PersonalAgentChat() {
  const [open, setOpen] = useState(false);
  const [dockState, setDockState] = useState<ChatDockState>(readDockState);
  const [sessionState, setSessionState] = useState<SessionState>({ phase: 'loading' });
  const [, forceUpdate] = useState(0);

  const sessionRef = useRef<InstanceSession | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const me = await getMe();
        if (cancelled) return;

        if (!me.personalTenantId || !me.paInstanceId) {
          setSessionState({ phase: 'provisioning' });
          return;
        }

        const transport = createBrowserTransport();
        const session = createInstanceSession({
          tenantId: me.personalTenantId,
          instanceId: me.paInstanceId,
          transport,
          onChange: () => {
            if (!cancelled) forceUpdate((n) => n + 1);
          },
          onError: (err) => {
            if (!cancelled) setSessionState({ phase: 'error', message: err.message });
          },
        });

        sessionRef.current = session;
        const stop = session.start();
        stopRef.current = stop;

        if (!cancelled) setSessionState({ phase: 'ready', session });
      } catch {
        if (!cancelled) {
          setSessionState({
            phase: 'error',
            message: 'Could not connect to Myra. Check your connection and try again.',
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      stopRef.current?.();
      stopRef.current = null;
      sessionRef.current?.destroy();
      sessionRef.current = null;
    };
  }, []);

  const toggleDock = () => {
    setDockState((prev) => {
      const next = prev === 'docked' ? 'floating' : 'docked';
      writeDockState(next);
      return next;
    });
  };

  function buildMessages(session: InstanceSession): ChatMessage[] {
    const committed = convertInstanceEvents(session.events);

    if (session.streaming) {
      const streamingMsg: ChatMessage = {
        id: 'streaming',
        role: 'agent',
        content: session.streaming,
        createdAt: new Date().toISOString(),
        status: 'sending',
      };
      return [...committed, streamingMsg];
    }

    return committed;
  }

  const setupNotice = (
    <span>
      Myra isn't set up yet —{' '}
      <Link to="/onboarding" className="text-orange underline">
        add an LLM API key to get started
      </Link>
      .
    </span>
  );

  function renderPanel() {
    if (sessionState.phase === 'loading') {
      return (
        <ChatPanel
          agent={MYRA}
          messages={[]}
          onSend={() => undefined}
          inputDisabled
          dockState={dockState}
          onToggleDock={toggleDock}
          onClose={() => setOpen(false)}
        />
      );
    }

    if (sessionState.phase === 'provisioning') {
      return (
        <ChatPanel
          agent={MYRA}
          messages={[]}
          onSend={() => undefined}
          inputDisabled
          notice={setupNotice}
          dockState={dockState}
          onToggleDock={toggleDock}
          onClose={() => setOpen(false)}
        />
      );
    }

    if (sessionState.phase === 'error') {
      return (
        <ChatPanel
          agent={MYRA}
          messages={[]}
          onSend={() => undefined}
          inputDisabled
          notice={setupNotice}
          dockState={dockState}
          onToggleDock={toggleDock}
          onClose={() => setOpen(false)}
        />
      );
    }

    const { session } = sessionState;
    const messages = buildMessages(session);
    const isTyping = !!session.streaming || !!session.activity;

    const handleSend = (text: string) => {
      void session.sendMail(text);
    };

    return (
      <ChatPanel
        agent={MYRA}
        messages={messages}
        onSend={handleSend}
        typing={isTyping}
        dockState={dockState}
        onToggleDock={toggleDock}
        onClose={() => setOpen(false)}
      />
    );
  }

  const panel = renderPanel();

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
