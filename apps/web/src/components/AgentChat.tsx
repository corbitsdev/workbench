import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createInstanceSession, type InstanceSession } from '@intx/hub-client';
import { convertInstanceEvents } from '@workbench/agents/browser';
import {
  ChatPanel,
  type ChatAgentIdentity,
  type ChatMessage,
  type ChatActivity,
} from '@workbench/chat';
import { type AgentActivity } from '@intx/hub-client';
import { launchInstanceSession } from '../lib/hub-api';
import { createHubTransport } from '../lib/instance-transport';

type SessionState =
  | { phase: 'loading' }
  | { phase: 'ready'; session: InstanceSession }
  | { phase: 'error'; message: string };

interface AgentChatProps {
  instanceId: string;
  tenantId: string;
  agentName: string;
  onClose?: () => void;
}

export function AgentChat({ instanceId, tenantId, agentName, onClose }: AgentChatProps) {
  const identity: ChatAgentIdentity = { name: agentName };

  const [sessionState, setSessionState] = useState<SessionState>({ phase: 'loading' });
  const [, forceUpdate] = useState(0);

  const sessionRef = useRef<InstanceSession | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  const { mutate: launch, status: launchStatus } = useMutation({
    mutationFn: async () => {
      const result = await launchInstanceSession(instanceId);
      if (!result.launched) {
        throw new Error(result.launchError ?? 'Failed to launch agent session');
      }
      return result;
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      setSessionState({ phase: 'error', message });
    },
  });

  // Reset state and trigger launch when instanceId changes (or on mount).
  useEffect(() => {
    setSessionState({ phase: 'loading' });
    launch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  // Subscription lifecycle — syncs to the external Interchange session.
  // Runs after launch succeeds so hydration errors do not hide launch failures.
  useEffect(() => {
    if (launchStatus !== 'success') return;

    let cancelled = false;

    const transport = createHubTransport();
    const session = createInstanceSession({
      tenantId,
      instanceId,
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

    return () => {
      cancelled = true;
      stopRef.current?.();
      stopRef.current = null;
      sessionRef.current?.destroy();
      sessionRef.current = null;
    };
  }, [instanceId, tenantId, launchStatus]);

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

  if (sessionState.phase === 'loading') {
    return (
      <ChatPanel
        agent={identity}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
        notice={<span className="text-[13px] text-text-3">Connecting to {agentName}…</span>}
        onClose={onClose}
      />
    );
  }

  if (sessionState.phase === 'error') {
    return (
      <ChatPanel
        agent={identity}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
        notice={
          <span className="text-[13px] text-text-2">
            Could not connect to {agentName}. {sessionState.message}
          </span>
        }
        onClose={onClose}
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

  return (
    <ChatPanel
      agent={identity}
      messages={messages}
      onSend={(text) => {
        void session.sendMail(text).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setSessionState({ phase: 'error', message });
        });
      }}
      activity={activity}
      onClose={onClose}
    />
  );
}
