import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createInstanceSession, type InstanceSession } from '@intx/hub-client';
import {
  composeChatMessages,
  friendlyToolSummary,
  summarizeToolCalls,
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
  ChatPanel,
  type ChatAgentIdentity,
  type ChatMessage,
  type ChatActivity,
  type ToolCall,
} from '@workbench/chat';
import { useCompactToolActivity, useToolSummaryStyle } from '@workbench/ui';
import { type AgentActivity } from '@intx/hub-client';
import {
  getOutputFeedback,
  launchInstanceSession,
  saveOutputFeedback,
  upsertRating,
} from '../lib/hub-api';
import type { FeedbackSubjectKind, SavedRating } from '../lib/hub-api';
import { createHubTransport } from '../lib/instance-transport';
import { classifyLaunchState, isLaunchableStatus } from './agent-launch-helpers';

// While a sidecar is restarting, the launch endpoint reports a transient
// "no sidecar available" error. Re-attempt the launch on an interval so the
// agent comes up on its own once the sidecar reconnects, instead of leaving the
// user stranded on a "waiting…" notice. Bounded so a genuinely-down sidecar
// eventually surfaces a retryable error instead of spinning forever.
const DEFAULT_RETRY_DELAY_MS = 4000;
const MAX_TRANSIENT_RETRIES = 8;

type SessionState =
  | { phase: 'loading' }
  | { phase: 'pending'; reason: 'deploying' | 'connecting' }
  | { phase: 'ready'; session: InstanceSession }
  | { phase: 'missing-config'; message: string }
  | { phase: 'error'; message: string };

interface AgentChatProps {
  instanceId: string;
  tenantId: string;
  agentName: string;
  instanceStatus?: string;
  onClose?: () => void;
  onConfigureAgent?: () => void;
  retryDelayMs?: number;
}

export function AgentChat({
  instanceId,
  tenantId,
  agentName,
  instanceStatus,
  onClose,
  onConfigureAgent,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}: AgentChatProps) {
  const identity: ChatAgentIdentity = { name: agentName };
  const { compact: compactToolActivity } = useCompactToolActivity();
  const { style: toolSummaryStyle } = useToolSummaryStyle();
  const summarize = (calls: ToolCall[]) => summarizeToolCalls(calls, toolSummaryStyle);

  const isLaunchable = isLaunchableStatus(instanceStatus);
  const [sessionState, setSessionState] = useState<SessionState>(
    isLaunchable ? { phase: 'loading' } : { phase: 'pending', reason: 'deploying' }
  );
  const [, forceUpdate] = useState(0);

  const sessionRef = useRef<InstanceSession | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const toolNamesRef = useRef<ToolNameTracker | null>(null);
  const liveTextRef = useRef<LiveTextTracker | null>(null);
  const reasoningRef = useRef<ReasoningTracker | null>(null);
  const imageTrackerRef = useRef<ImageTracker | null>(null);
  const queryClient = useQueryClient();

  const { data: ratingsData } = useQuery({
    queryKey: ['feedback', instanceId],
    queryFn: () => getOutputFeedback(instanceId),
    enabled: !!instanceId,
    staleTime: 5 * 60_000,
  });

  const ratingsMap = useMemo(
    () => new Map((ratingsData ?? []).map((r) => [`${r.subjectId}:${r.subjectKind}`, r.rating])),
    [ratingsData]
  );

  const { mutateAsync: rateMutateAsync } = useMutation({
    mutationFn: ({
      subjectId,
      subjectKind,
      rating,
    }: {
      subjectId: string;
      subjectKind: FeedbackSubjectKind;
      rating: 1 | -1;
    }) => saveOutputFeedback(instanceId, subjectId, subjectKind, rating),
    onSuccess: (_, { subjectId, subjectKind, rating }) => {
      queryClient.setQueryData<SavedRating[]>(['feedback', instanceId], (prev) =>
        upsertRating(prev, { subjectId, subjectKind, rating })
      );
    },
  });

  const { mutate: launch, status: launchStatus } = useMutation({
    mutationFn: async () => {
      const result = await launchInstanceSession(instanceId);
      if (!result.launched) {
        const launchError = result.launchError ?? 'Failed to launch agent session';
        const classified = classifyLaunchState(instanceStatus, launchError);
        if (classified.kind === 'connecting' || classified.kind === 'deploying') {
          setSessionState({
            phase: 'pending',
            reason: classified.kind === 'deploying' ? 'deploying' : 'connecting',
          });
        }
        throw new Error(launchError);
      }
      return result;
    },
    retry: (failureCount, error) => {
      const launchError = error instanceof Error ? error.message : String(error);
      const classified = classifyLaunchState(instanceStatus, launchError);
      return (
        (classified.kind === 'connecting' || classified.kind === 'deploying') &&
        failureCount < MAX_TRANSIENT_RETRIES
      );
    },
    retryDelay: retryDelayMs,
    onError: (err) => {
      const launchError = err instanceof Error ? err.message : String(err);
      const classified = classifyLaunchState(instanceStatus, launchError);
      if (classified.kind === 'connecting' || classified.kind === 'deploying') {
        setSessionState({ phase: 'pending', reason: classified.kind });
      } else if (classified.kind === 'missing-config') {
        setSessionState({
          phase: 'missing-config',
          message: classified.message,
        });
      } else {
        setSessionState({ phase: 'error', message: classified.message });
      }
    },
  });

  // Reset state and trigger launch when instanceId changes (or on mount).
  // Skip launch only when the instance is not launchable (stopped/provisioning)
  // — show the passive deploying notice instead.
  useEffect(() => {
    if (!isLaunchable) return;
    setSessionState({ phase: 'loading' });
    launch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, isLaunchable]);

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

    // Capture tool names from the live stream so committed turns whose tool
    // "call" part failed to persist still render the real tool instead of a
    // generic "Tool call" (see CL-1398).
    // toolNameTracker retains its onUpdate because tool names are resolved once
    // per tool call (not per streaming token), so the extra render is rare and
    // does not cause per-token stutter. Unlike liveTextTracker, the cost of
    // missing a render here (tool name stays as "Tool call" after commit) is
    // visible to the user.
    toolNamesRef.current = createToolNameTracker(transport, { tenantId, instanceId }, () => {
      if (!cancelled) forceUpdate((n) => n + 1);
    });

    // Track the current turn's live text from the raw stream. The session's own
    // `streaming` buffer accumulates across turns when a turn commits empty
    // (CL-1398) and would merge separate replies into one bubble (CL-1643).
    // No onUpdate — the session's onChange is the sole render trigger. The
    // tracker updates its internal text silently; reading it at render time
    // avoids a double-render race where the session and tracker connections
    // deliver the same delta at slightly different times (three independent
    // SSE connections to the same endpoint).
    liveTextRef.current = createLiveTextTracker(transport, {
      tenantId,
      instanceId,
    });

    // Live reasoning for the current turn, sourced like the text tracker. No
    // onUpdate — the session's onChange drives renders; we read it at render.
    reasoningRef.current = createReasoningTracker(transport, {
      tenantId,
      instanceId,
    });

    // Live images for the current turn. No onUpdate — the session's onChange
    // drives renders; we read the captured images at render time.
    imageTrackerRef.current = createImageTracker(transport, {
      tenantId,
      instanceId,
    });

    if (!cancelled) setSessionState({ phase: 'ready', session });

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
  }, [instanceId, tenantId, launchStatus]);

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

  if (sessionState.phase === 'loading') {
    return (
      <ChatPanel
        agent={identity}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
        notice={<span className="text-[13px] text-text-3">Connecting to {agentName}...</span>}
        onClose={onClose}
      />
    );
  }

  if (sessionState.phase === 'pending') {
    const copy =
      sessionState.reason === 'deploying'
        ? `${agentName} is still starting up. This usually takes a few seconds.`
        : `Waiting for ${agentName} to become available...`;
    return (
      <ChatPanel
        agent={identity}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
        notice={<span className="text-[13px] text-text-3">{copy}</span>}
        onClose={onClose}
      />
    );
  }

  if (sessionState.phase === 'missing-config') {
    return (
      <ChatPanel
        agent={identity}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
        notice={
          <span className="text-[13px] text-text-2">
            {agentName} needs a credential before it can start.{' '}
            {onConfigureAgent ? (
              <button className="underline" onClick={onConfigureAgent}>
                Configure the agent
              </button>
            ) : (
              'Add a credential in Settings to continue.'
            )}
          </span>
        }
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
            {agentName} could not be reached.{' '}
            <button
              className="underline"
              onClick={() => {
                setSessionState({ phase: 'loading' });
                launch();
              }}
            >
              Try again
            </button>
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
      onRate={(subjectId, subjectKind, rating) =>
        rateMutateAsync({ subjectId, subjectKind, rating }).catch(() => {})
      }
      getRating={(subjectId: string, subjectKind: FeedbackSubjectKind) =>
        ratingsMap.get(`${subjectId}:${subjectKind}`) ?? null
      }
      formatToolSummary={friendlyToolSummary}
      compactToolActivity={compactToolActivity}
      summarizeToolCalls={summarize}
    />
  );
}
