import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, createInstanceSession, type InstanceSession } from '@intx/hub-client';
import {
  composeChatMessages,
  createToolNameTracker,
  createLiveTextTracker,
  createReasoningTracker,
  createImageTracker,
  type ToolNameTracker,
  type LiveTextTracker,
  type ReasoningTracker,
  type ImageTracker,
} from '@workbench/agents/browser';
import {
  ChatLauncher,
  ChatPanel,
  DockedChatBar,
  DOCKED_BAR_HEIGHT,
  FloatingChat,
  type ChatAgentIdentity,
  type ChatDockState,
  type ChatMessage,
  type ChatActivity,
  type UIResponse,
} from '@workbench/chat';
import { type AgentActivity } from '@intx/hub-client';
import {
  getMe,
  getOutputFeedback,
  launchInstanceSession,
  saveOutputFeedback,
} from '../lib/hub-api';
import type { FeedbackSubjectKind } from '../lib/hub-api';
import { createHubTransport } from '../lib/instance-transport';
import { useChatLauncher } from '../lib/chat-launcher-context';

const MYRA: ChatAgentIdentity = { name: 'Myra', tagline: 'Personal agent' };

// Send a message to Myra, recovering from a dropped session once. A hub or
// sidecar restart leaves the instance not running, so the first send 409s;
// relaunching the session and retrying heals it without losing the message.
async function deliverMessage(
  session: InstanceSession,
  instanceId: string | null,
  content: string
): Promise<void> {
  try {
    await session.sendMail(content);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && instanceId !== null) {
      await launchInstanceSession(instanceId);
      await session.sendMail(content);
      return;
    }
    throw err;
  }
}

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
  const [sessionState, setSessionState] = useState<SessionState>({
    phase: 'loading',
  });
  const [, forceUpdate] = useState(0);
  const instanceIdRef = useRef<string | null>(null);
  // Bumping this re-runs the connect effect — used by the error-state retry so a
  // transient hydration/transport failure does not permanently brick the panel.
  const [attempt, setAttempt] = useState(0);

  const sessionRef = useRef<InstanceSession | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const toolNamesRef = useRef<ToolNameTracker | null>(null);
  const liveTextRef = useRef<LiveTextTracker | null>(null);
  const reasoningRef = useRef<ReasoningTracker | null>(null);
  const imageTrackerRef = useRef<ImageTracker | null>(null);

  const {
    hidden: launcherHidden,
    registerReconnect,
    pendingMessage,
    clearPendingMessage,
  } = useChatLauncher();

  useEffect(() => {
    registerReconnect(() => setAttempt((n) => n + 1));
  }, [registerReconnect]);

  // Deliver a message requested via "Open in Myra". Opening the panel is
  // immediate; the send waits until the session is ready, then clears the
  // pending message so it is delivered exactly once.
  useEffect(() => {
    if (pendingMessage === null) return;
    setOpen(true);
    // Drop the pending message on a terminal session state so it cannot be
    // delivered out of nowhere when an unrelated session later reaches 'ready'.
    if (sessionState.phase === 'error' || sessionState.phase === 'credential-error') {
      clearPendingMessage();
      return;
    }
    if (sessionState.phase !== 'ready') return;
    const { session } = sessionState;
    const instanceId = instanceIdRef.current;
    void deliverMessage(session, instanceId, pendingMessage).catch(() => {
      setSessionState({
        phase: 'error',
        message: 'Could not reach Myra. Check your connection and try again.',
      });
    });
    clearPendingMessage();
  }, [pendingMessage, sessionState, clearPendingMessage]);

  useEffect(() => {
    let cancelled = false;
    setSessionState({ phase: 'loading' });

    async function connect() {
      try {
        const me = await getMe();
        if (cancelled) return;

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

        // Capture tool names from the live stream so committed turns whose tool
        // "call" part failed to persist still render the real tool instead of a
        // generic "Tool call" (see CL-1398).
        // toolNameTracker retains its onUpdate because tool names are resolved once
        // per tool call (not per streaming token), so the extra render is rare and
        // does not cause per-token stutter. Unlike liveTextTracker, the cost of
        // missing a render here (tool name stays as "Tool call" after commit) is
        // visible to the user.
        toolNamesRef.current = createToolNameTracker(
          transport,
          { tenantId: me.personalTenantId, instanceId: me.paInstanceId },
          () => {
            if (!cancelled) forceUpdate((n) => n + 1);
          }
        );

        // Track the current turn's live text from the raw stream. The session's
        // own `streaming` buffer accumulates across turns when a turn commits
        // empty (CL-1398) and would merge separate replies into one (CL-1643).
        // No onUpdate — same rationale as AgentChat: avoid double-render race
        // between the session and tracker SSE connections.
        liveTextRef.current = createLiveTextTracker(transport, {
          tenantId: me.personalTenantId,
          instanceId: me.paInstanceId,
        });
        reasoningRef.current = createReasoningTracker(transport, {
          tenantId: me.personalTenantId,
          instanceId: me.paInstanceId,
        });
        imageTrackerRef.current = createImageTracker(transport, {
          tenantId: me.personalTenantId,
          instanceId: me.paInstanceId,
        });

        if (!cancelled) setSessionState({ phase: 'ready', session });
      } catch {
        if (!cancelled) {
          setSessionState({
            phase: 'error',
            message: 'Could not connect to Myra. Check your connection and try again.',
          });
        }
      }
    }

    void connect();

    return () => {
      cancelled = true;
      stopRef.current?.();
      stopRef.current = null;
      toolNamesRef.current?.stop();
      toolNamesRef.current = null;
      liveTextRef.current?.stop();
      liveTextRef.current = null;
      reasoningRef.current?.stop();
      reasoningRef.current = null;
      imageTrackerRef.current?.stop();
      imageTrackerRef.current = null;
      sessionRef.current?.destroy();
      sessionRef.current = null;
    };
  }, [attempt]);

  const queryClient = useQueryClient();

  const instanceId = instanceIdRef.current;

  const { data: ratingsData } = useQuery({
    queryKey: ['feedback', instanceId],
    queryFn: () => getOutputFeedback(instanceId!),
    enabled: instanceId !== null,
    staleTime: 5 * 60_000,
  });

  const ratingsMap = new Map(
    (ratingsData ?? []).map((r) => [`${r.subjectId}:${r.subjectKind}`, r.rating])
  );

  const { mutateAsync: rateMutateAsync } = useMutation({
    mutationFn: ({
      instanceId: iid,
      subjectId,
      subjectKind,
      rating,
    }: {
      instanceId: string;
      subjectId: string;
      subjectKind: Parameters<typeof saveOutputFeedback>[2];
      rating: 1 | -1;
    }) => saveOutputFeedback(iid, subjectId, subjectKind, rating),
    onSuccess: (_, { instanceId: iid }) => {
      void queryClient.invalidateQueries({ queryKey: ['feedback', iid] });
    },
  });

  const reconnect = () => setAttempt((n) => n + 1);

  const toggleDock = () => {
    setDockState((prev) => {
      const next = prev === 'docked' ? 'floating' : 'docked';
      writeDockState(next);
      return next;
    });
  };

  function buildMessages(session: InstanceSession): ChatMessage[] {
    const { messages } = composeChatMessages({
      events: session.events,
      streaming: liveTextRef.current !== null ? liveTextRef.current.text : '',
      reasoning: reasoningRef.current !== null ? reasoningRef.current.text : '',
      ...(toolNamesRef.current !== null ? { toolNames: toolNamesRef.current.names } : {}),
      ...(imageTrackerRef.current !== null && imageTrackerRef.current.images.length > 0
        ? { liveImages: imageTrackerRef.current.images }
        : {}),
    });
    return messages;
  }

  // Shown when Myra is provisioned but no credential resolves for her. The org
  // LLM credential is admin-managed, so members are directed to their admin.
  const credentialErrorNotice = (
    <span>No API credential is set up for Myra. Ask your admin to finish workspace setup.</span>
  );

  // Shown while Myra's personal tenant and instance are still being provisioned.
  // This is server-side auto-provisioning, so the member only needs to wait.
  const setupNotice = <span>Setting up Myra for your workspace…</span>;

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

    const handleSend = (text: string) => {
      void deliverMessage(session, instanceIdRef.current, text).catch(() => {
        setSessionState({
          phase: 'error',
          message: 'Could not reach Myra. Check your connection and try again.',
        });
      });
    };

    // Closes the generative-UI loop: an interactive block's selection is sent
    // back as the next user turn, exactly as if the user had typed it.
    const handleRespond = (response: UIResponse) => {
      handleSend(response.value);
    };

    const currentInstanceId = instanceIdRef.current;
    const onRate =
      currentInstanceId !== null
        ? (
            subjectId: string,
            subjectKind: Parameters<typeof saveOutputFeedback>[2],
            rating: 1 | -1
          ) =>
            rateMutateAsync({
              instanceId: currentInstanceId,
              subjectId,
              subjectKind,
              rating,
            }).catch(() => {})
        : undefined;

    const getRating =
      currentInstanceId !== null
        ? (subjectId: string, subjectKind: FeedbackSubjectKind) =>
            ratingsMap.get(`${subjectId}:${subjectKind}`) ?? null
        : undefined;

    return (
      <ChatPanel
        agent={MYRA}
        messages={messages}
        onSend={handleSend}
        onRespond={handleRespond}
        activity={activity}
        dockState={dockState}
        onToggleDock={toggleDock}
        onClose={() => setOpen(false)}
        onRate={onRate}
        getRating={getRating}
      />
    );
  }

  const panel = renderPanel();

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
      <FloatingChat open={open}>{panel}</FloatingChat>
    </>
  );
}
