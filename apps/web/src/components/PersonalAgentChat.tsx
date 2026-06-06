import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, createInstanceSession, type InstanceSession } from '@intx/hub-client';
import { buildContextBlock, convertInstanceEvents } from '@workbench/agents/browser';
import {
  ChatLauncher,
  ChatPanel,
  DockedChat,
  FloatingChat,
  type ChatAgentIdentity,
  type ChatDockState,
  type ChatMessage,
  type ChatActivity,
} from '@workbench/chat';
import { type AgentActivity } from '@intx/hub-client';
import { getMe, launchInstanceSession } from '../lib/hub-api';
import { createHubTransport } from '../lib/instance-transport';
import { useChatLauncher } from '../lib/chat-launcher-context';

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
  | { phase: 'credential-error' }
  | { phase: 'ready'; session: InstanceSession }
  | { phase: 'error'; message: string };

export function PersonalAgentChat() {
  const [open, setOpen] = useState(false);
  const [dockState, setDockState] = useState<ChatDockState>(readDockState);
  const [sessionState, setSessionState] = useState<SessionState>({ phase: 'loading' });
  const [, forceUpdate] = useState(0);
  const [me, setMe] = useState<{ userName: string } | null>(null);
  const instanceIdRef = useRef<string | null>(null);
  // Bumping this re-runs the connect effect — used by the error-state retry so a
  // transient hydration/transport failure does not permanently brick the panel.
  const [attempt, setAttempt] = useState(0);

  const sessionRef = useRef<InstanceSession | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const contextInjectedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setSessionState({ phase: 'loading' });

    void (async () => {
      try {
        const me = await getMe();
        if (cancelled) return;
        if (!cancelled) setMe({ userName: me.userName });

        if (!me.personalTenantId || !me.paInstanceId) {
          setSessionState({ phase: 'provisioning' });
          return;
        }

        if (!me.credentialResolved) {
          setSessionState({ phase: 'credential-error' });
          return;
        }

        instanceIdRef.current = me.paInstanceId;
        const transport = createHubTransport();
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
  }, [attempt]);

  const reconnect = () => setAttempt((n) => n + 1);

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

  // Shown when Myra is provisioned but no credential resolves for her.
  const credentialErrorNotice = (
    <span>
      No API credential is set up for Myra.{' '}
      <Link to="/settings/credentials" className="text-orange underline">
        Add a credential in Settings
      </Link>{' '}
      to get started.
    </span>
  );

  // Shown only when Myra has not been provisioned with a credential yet.
  const setupNotice = (
    <span>
      Myra isn't set up yet —{' '}
      <Link to="/onboarding" className="text-orange underline">
        add an LLM API key to get started
      </Link>
      .
    </span>
  );

  // Shown when the session exists but we failed to connect or hydrate it. This
  // is recoverable — retrying re-runs the connect effect rather than telling the
  // user to add a key they already have.
  const errorNotice = (
    <span>
      Couldn't reach Myra.{' '}
      <button type="button" onClick={reconnect} className="text-orange underline">
        Try again
      </button>
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

    if (sessionState.phase === 'credential-error') {
      return (
        <ChatPanel
          agent={MYRA}
          messages={[]}
          onSend={() => undefined}
          inputDisabled
          notice={credentialErrorNotice}
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
          notice={errorNotice}
          dockState={dockState}
          onToggleDock={toggleDock}
          onClose={() => setOpen(false)}
        />
      );
    }

    const { session } = sessionState;
    const messages = buildMessages(session);
    function toChatActivity(a: AgentActivity | null): ChatActivity | null {
      if (a === null) return null;
      if (a.type === 'inferring') return { type: 'thinking' };
      return a as ChatActivity;
    }

    const activity: ChatActivity | null = toChatActivity(session.activity);

    // Send mail, recovering from a dropped session. A hub or sidecar restart
    // leaves the instance not running, so the first send 409s; relaunching the
    // session and retrying once heals it without bouncing the user to an error
    // state or silently losing their message.
    const sendWithRecovery = async (content: string) => {
      try {
        await session.sendMail(content);
      } catch (err) {
        const instanceId = instanceIdRef.current;
        if (!(err instanceof ApiError && err.status === 409) || instanceId === null) {
          throw err;
        }
        await launchInstanceSession(instanceId);
        await session.sendMail(content);
      }
    };

    const handleSend = (text: string) => {
      let content = text;
      if (!contextInjectedRef.current && me !== null) {
        contextInjectedRef.current = true;
        const date = new Date().toLocaleDateString('en-GB');
        const contextBlock = buildContextBlock({ date, 'Human Operator': me.userName }, 'xml');
        content = `${contextBlock}\n\n${text}`;
      }
      void sendWithRecovery(content).catch(() => {
        setSessionState({
          phase: 'error',
          message: 'Could not reach Myra. Check your connection and try again.',
        });
      });
    };

    return (
      <ChatPanel
        agent={MYRA}
        messages={messages}
        onSend={handleSend}
        activity={activity}
        dockState={dockState}
        onToggleDock={toggleDock}
        onClose={() => setOpen(false)}
      />
    );
  }

  const { hidden: launcherHidden } = useChatLauncher();
  const panel = renderPanel();

  if (dockState === 'docked') {
    return <DockedChat side="right">{panel}</DockedChat>;
  }

  return (
    <>
      {!launcherHidden && <ChatLauncher onClick={() => setOpen((prev) => !prev)} open={open} />}
      <FloatingChat open={open}>{panel}</FloatingChat>
    </>
  );
}
