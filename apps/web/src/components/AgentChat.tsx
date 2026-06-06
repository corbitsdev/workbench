import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  createBrowserTransport,
  createInstanceSession,
  type InstanceSession,
} from '@intx/hub-client';
import { convertInstanceEvents } from '@workbench/agents/browser';
import { ChatPanel, type ChatAgentIdentity, type ChatMessage } from '@workbench/chat';
import { launchInstanceSession } from '../lib/hub-api';

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

  // Launch the sidecar session. Errors are silently ignored — the session may
  // already be running, in which case the subscription below will still hydrate.
  const { mutate: launch, status: launchStatus } = useMutation({
    mutationFn: () => launchInstanceSession(instanceId),
    onError: () => {},
  });

  // Trigger launch once when the component mounts or instanceId changes.
  const prevInstanceRef = useRef<string | null>(null);
  if (prevInstanceRef.current !== instanceId) {
    prevInstanceRef.current = instanceId;
    launch();
  }

  // Subscription lifecycle — syncs to the external Interchange session.
  // Runs after launch settles (success or error) so the sidecar is ready.
  useEffect(() => {
    if (launchStatus === 'pending') return;

    let cancelled = false;

    const transport = createBrowserTransport();
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
  const isTyping = !!session.streaming || !!session.activity;

  return (
    <ChatPanel
      agent={identity}
      messages={messages}
      onSend={(text) => void session.sendMail(text)}
      typing={isTyping}
      onClose={onClose}
    />
  );
}
