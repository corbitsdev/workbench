import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, createInstanceSession, type InstanceSession } from '@intx/hub-client';
import { type AgentActivity } from '@intx/hub-client';
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
import type { ChatActivity, ChatMessage } from '@workbench/chat';
import {
  ensureMeSynced,
  getOutputFeedback,
  launchInstanceSession,
  saveOutputFeedback,
  upsertRating,
} from '../lib/hub-api';
import type { FeedbackSubjectKind, SavedRating } from '../lib/hub-api';
import { createHubTransport } from '../lib/instance-transport';
import { classifyLaunchState } from '../components/agent-launch-helpers';

const LAUNCH_RETRY_DELAY_MS = 4000;
const MAX_LAUNCH_TRANSIENT_RETRIES = 8;

export type MyraSessionPhase =
  | { phase: 'loading' }
  | { phase: 'provisioning' }
  | { phase: 'credential-error' }
  | { phase: 'ready'; session: InstanceSession }
  | { phase: 'error'; message: string };

// Send a message to Myra, recovering from a dropped session once. A hub or
// sidecar restart leaves the instance not running, so the first send 409s;
// relaunching the session and retrying heals it without losing the message.
export async function deliverMessage(
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

function toChatActivity(a: AgentActivity | null): ChatActivity | null {
  if (a === null) return null;
  if (a.type === 'inferring') return { type: 'thinking' };
  return a as ChatActivity;
}

export type MyraSession = {
  state: MyraSessionPhase;
  messages: ChatMessage[];
  activity: ChatActivity | null;
  send: (text: string) => void;
  reconnect: () => void;
  instanceId: string | null;
  onRate?: (subjectId: string, subjectKind: FeedbackSubjectKind, rating: 1 | -1) => Promise<void>;
  getRating?: (subjectId: string, subjectKind: FeedbackSubjectKind) => 1 | -1 | null;
};

/**
 * Connects to a single Myra instance (chat thread) over the hub transport,
 * driving the same launch + SSE-tracker lifecycle as the original single-instance
 * PersonalAgentChat. Pass the thread's `instanceId`; pass `null` to fall back to
 * the member's default Myra instance (`/me` paInstanceId) while the caller is
 * still resolving the active thread.
 */
export function useMyraSession(instanceId: string | null, enabled = true): MyraSession {
  const [state, setState] = useState<MyraSessionPhase>({ phase: 'loading' });
  const [, forceUpdate] = useState(0);
  const resolvedInstanceIdRef = useRef<string | null>(null);
  const [resolvedInstanceId, setResolvedInstanceId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const sessionRef = useRef<InstanceSession | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const toolNamesRef = useRef<ToolNameTracker | null>(null);
  const liveTextRef = useRef<LiveTextTracker | null>(null);
  const reasoningRef = useRef<ReasoningTracker | null>(null);
  const imageTrackerRef = useRef<ImageTracker | null>(null);

  useEffect(() => {
    // Connect only once the caller has resolved a concrete thread instance.
    // Connecting on a fallback id before the thread list loads caused a wasted
    // launch + a flash back to `loading`, then a churn to the real instance.
    if (!enabled || !instanceId) return;
    let cancelled = false;
    setState({ phase: 'loading' });

    const targetInstanceId = instanceId;

    async function connect() {
      try {
        const me = await ensureMeSynced();
        if (cancelled) return;

        if (!me.personalTenantId) {
          setState({ phase: 'provisioning' });
          return;
        }

        if (!me.credentialResolved) {
          setState({ phase: 'credential-error' });
          return;
        }

        resolvedInstanceIdRef.current = targetInstanceId;
        setResolvedInstanceId(targetInstanceId);

        // Same launch path as workspace agents (Oat): persist tool grants from the
        // org definition and push them to a live sidecar before opening chat.
        for (let launchAttempt = 0; ; launchAttempt++) {
          const launch = await launchInstanceSession(targetInstanceId);
          if (launch.launched) break;
          const launchError = launch.launchError ?? 'Failed to launch Myra session';
          const classified = classifyLaunchState(undefined, launchError);
          if (
            (classified.kind === 'connecting' || classified.kind === 'deploying') &&
            launchAttempt < MAX_LAUNCH_TRANSIENT_RETRIES
          ) {
            await new Promise<void>((resolve) => setTimeout(resolve, LAUNCH_RETRY_DELAY_MS));
            continue;
          }
          throw new Error(launchError);
        }

        const transport = createHubTransport();
        const session = createInstanceSession({
          tenantId: me.personalTenantId,
          instanceId: targetInstanceId,
          transport,
          onChange: () => {
            if (!cancelled) forceUpdate((n) => n + 1);
          },
          onError: (err) => {
            if (!cancelled) setState({ phase: 'error', message: err.message });
          },
        });

        sessionRef.current = session;
        const stop = session.start();
        stopRef.current = stop;

        // Capture tool names from the live stream so committed turns whose tool
        // "call" part failed to persist still render the real tool (CL-1398).
        toolNamesRef.current = createToolNameTracker(
          transport,
          { tenantId: me.personalTenantId, instanceId: targetInstanceId },
          () => {
            if (!cancelled) forceUpdate((n) => n + 1);
          }
        );

        // Track the current turn's live text from the raw stream (CL-1643).
        liveTextRef.current = createLiveTextTracker(transport, {
          tenantId: me.personalTenantId,
          instanceId: targetInstanceId,
        });
        reasoningRef.current = createReasoningTracker(transport, {
          tenantId: me.personalTenantId,
          instanceId: targetInstanceId,
        });
        imageTrackerRef.current = createImageTracker(transport, {
          tenantId: me.personalTenantId,
          instanceId: targetInstanceId,
        });

        if (!cancelled) setState({ phase: 'ready', session });
      } catch {
        if (!cancelled) {
          setState({
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
  }, [attempt, instanceId, enabled]);

  const queryClient = useQueryClient();

  const { data: ratingsData } = useQuery({
    queryKey: ['feedback', resolvedInstanceId],
    queryFn: () => getOutputFeedback(resolvedInstanceId as string),
    enabled: resolvedInstanceId !== null,
    staleTime: 5 * 60_000,
  });

  const ratingsMap = useMemo(
    () => new Map((ratingsData ?? []).map((r) => [`${r.subjectId}:${r.subjectKind}`, r.rating])),
    [ratingsData]
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
      subjectKind: FeedbackSubjectKind;
      rating: 1 | -1;
    }) => saveOutputFeedback(iid, subjectId, subjectKind, rating),
    onSuccess: (_, { instanceId: iid, subjectId, subjectKind, rating }) => {
      queryClient.setQueryData<SavedRating[]>(['feedback', iid], (prev) =>
        upsertRating(prev, { subjectId, subjectKind, rating })
      );
    },
  });

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  const session = state.phase === 'ready' ? state.session : null;

  const messages: ChatMessage[] = session
    ? composeChatMessages({
        events: session.events,
        streaming: liveTextRef.current !== null ? liveTextRef.current.text : '',
        reasoning: reasoningRef.current !== null ? reasoningRef.current.text : '',
        ...(toolNamesRef.current !== null ? { toolNames: toolNamesRef.current.names } : {}),
        ...(imageTrackerRef.current !== null && imageTrackerRef.current.images.length > 0
          ? { liveImages: imageTrackerRef.current.images }
          : {}),
      }).messages
    : [];

  const activity = session ? toChatActivity(session.activity) : null;

  const send = (text: string) => {
    if (!session) return;
    void deliverMessage(session, resolvedInstanceIdRef.current, text).catch(() => {
      setState({
        phase: 'error',
        message: 'Could not reach Myra. Check your connection and try again.',
      });
    });
  };

  const currentInstanceId = resolvedInstanceId;
  const onRate =
    currentInstanceId !== null
      ? (subjectId: string, subjectKind: FeedbackSubjectKind, rating: 1 | -1) =>
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

  return {
    state,
    messages,
    activity,
    send,
    reconnect,
    instanceId: resolvedInstanceId,
    ...(onRate ? { onRate } : {}),
    ...(getRating ? { getRating } : {}),
  };
}
