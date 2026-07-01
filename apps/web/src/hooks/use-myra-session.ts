import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createInstanceSession,
  type InstanceSession,
  type Transport,
} from "@intx/hub-client";
import { type AgentActivity } from "@intx/hub-client";
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
} from "@workbench/agents/browser";
import type {
  ChatActivity,
  ChatMessage,
  PendingAttachment,
} from "@workbench/chat";
import {
  ensureMeSynced,
  getOutputFeedback,
  launchInstanceSession,
  saveOutputFeedback,
  upsertRating,
} from "../lib/hub-api";
import type { FeedbackSubjectKind, SavedRating } from "../lib/hub-api";
import {
  createHubTransport,
  fetchBlobObjectUrl,
} from "../lib/instance-transport";
import { classifyLaunchState } from "../components/agent-launch-helpers";

const LAUNCH_RETRY_DELAY_MS = 4000;
const MAX_LAUNCH_TRANSIENT_RETRIES = 8;

export type MyraSessionPhase =
  | { phase: "loading" }
  | { phase: "provisioning" }
  | { phase: "credential-error" }
  | { phase: "ready"; session: InstanceSession }
  | { phase: "error"; message: string };

// Send a message to Myra, recovering from a dropped session once. A hub or
// sidecar restart leaves the instance not running, so the first send 409s;
// relaunching the session and retrying heals it without losing the message.
export async function deliverMessage(
  session: InstanceSession,
  instanceId: string | null,
  content: string,
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

// Wire shape the mail route accepts alongside `content` (SendMessage schema).
export interface OutboundAttachment {
  mimeType: string;
  data: string;
  name?: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected file read result"));
        return;
      }
      // readAsDataURL yields "data:<mime>;base64,<data>"; keep only the payload.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

async function encodeAttachments(
  attachments: readonly PendingAttachment[],
): Promise<OutboundAttachment[]> {
  return Promise.all(
    attachments.map(async (a) => ({
      mimeType: a.mimeType,
      data: await fileToBase64(a.file),
      name: a.name,
    })),
  );
}

// The hub validates attachments at the mail route and returns structured
// AttachmentError codes. Translate them into plain-language composer errors —
// never surface the raw code (apps/web/AGENTS.md).
export function attachmentErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return "Could not send your attachment. Check your connection and try again.";
  }
  switch (err.code) {
    case "oversize_attachment":
      return "One of your files is too large (10 MB max per file).";
    case "oversize_total":
      return "Your files are too large together (30 MB max per message).";
    case "disallowed_mime_type":
      return "One of your files is a type this agent cannot read.";
    case "invalid_attachment_name":
      return "One of your files has an invalid name.";
    case "malformed_base64":
      return "One of your files could not be read. Remove it and add it again.";
    case "disallowed_for_agent":
      return "This agent can't read that file type.";
    default:
      return "Could not send your attachment. Try again.";
  }
}

// Attachments cannot ride the string-only `sendMail`; POST them to the same
// mail route the session uses, with the one-shot relaunch-on-409 recovery.
export async function deliverMessageWithAttachments(
  transport: Transport,
  tenantId: string,
  instanceId: string,
  content: string,
  attachments: OutboundAttachment[],
): Promise<void> {
  const path = `/api/tenants/${tenantId}/agents/instances/${instanceId}/mail`;
  const body = { content, attachments };
  try {
    await transport.fetch("POST", path, body);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      await launchInstanceSession(instanceId);
      await transport.fetch("POST", path, body);
      return;
    }
    throw err;
  }
}

function toChatActivity(a: AgentActivity | null): ChatActivity | null {
  if (a === null) return null;
  if (a.type === "inferring") return { type: "thinking" };
  return a as ChatActivity;
}

export type MyraSession = {
  state: MyraSessionPhase;
  messages: ChatMessage[];
  activity: ChatActivity | null;
  send: (
    text: string,
    attachments?: PendingAttachment[],
  ) => void | Promise<void>;
  reconnect: () => void;
  instanceId: string | null;
  onRate?: (
    subjectId: string,
    subjectKind: FeedbackSubjectKind,
    rating: 1 | -1,
  ) => Promise<void>;
  getRating?: (
    subjectId: string,
    subjectKind: FeedbackSubjectKind,
  ) => 1 | -1 | null;
  /** Resolves a mail-attachment blob to an object URL, cached per blobId. */
  resolveAttachmentUrl?: (blobId: string) => Promise<string>;
};

/**
 * Connects to a single Myra instance (chat thread) over the hub transport,
 * driving the same launch + SSE-tracker lifecycle as the original single-instance
 * PersonalAgentChat. Pass the thread's `instanceId` and the `tenantId` of the
 * active workbench the thread lives in — the instance is created in the active
 * workbench (not the root org), so the session/SSE must connect there. Pass a
 * null `instanceId`/`tenantId` while the caller is still resolving the active
 * thread or workbench; the session stays in `loading` until both are present.
 */
export function useMyraSession(
  instanceId: string | null,
  tenantId: string | null,
  enabled = true,
): MyraSession {
  const [state, setState] = useState<MyraSessionPhase>({ phase: "loading" });
  const [, forceUpdate] = useState(0);
  const resolvedInstanceIdRef = useRef<string | null>(null);
  const [resolvedInstanceId, setResolvedInstanceId] = useState<string | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);

  const sessionRef = useRef<InstanceSession | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const toolNamesRef = useRef<ToolNameTracker | null>(null);
  const liveTextRef = useRef<LiveTextTracker | null>(null);
  const reasoningRef = useRef<ReasoningTracker | null>(null);
  const imageTrackerRef = useRef<ImageTracker | null>(null);
  const transportRef = useRef<Transport | null>(null);
  // blobId → in-flight/settled object-URL promise, so a re-render never
  // re-fetches the same blob. Cleared and revoked on session teardown.
  const attachmentUrlsRef = useRef<Map<string, Promise<string>>>(new Map());

  useEffect(() => {
    // Connect only once the caller has resolved a concrete thread instance.
    // Connecting on a fallback id before the thread list loads caused a wasted
    // launch + a flash back to `loading`, then a churn to the real instance.
    if (!enabled || !instanceId || !tenantId) return;
    let cancelled = false;
    setState({ phase: "loading" });

    const targetInstanceId = instanceId;
    const targetTenantId = tenantId;

    async function connect() {
      try {
        const me = await ensureMeSynced();
        if (cancelled) return;

        if (!me.personalTenantId) {
          setState({ phase: "provisioning" });
          return;
        }

        if (!me.credentialResolved) {
          setState({ phase: "credential-error" });
          return;
        }

        resolvedInstanceIdRef.current = targetInstanceId;
        setResolvedInstanceId(targetInstanceId);

        // Same launch path as workspace agents (Oat): persist tool grants from the
        // org definition and push them to a live sidecar before opening chat.
        for (let launchAttempt = 0; ; launchAttempt++) {
          const launch = await launchInstanceSession(targetInstanceId);
          if (launch.launched) break;
          const launchError =
            launch.launchError ?? "Failed to launch Myra session";
          const classified = classifyLaunchState(undefined, launchError);
          if (
            (classified.kind === "connecting" ||
              classified.kind === "deploying") &&
            launchAttempt < MAX_LAUNCH_TRANSIENT_RETRIES
          ) {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, LAUNCH_RETRY_DELAY_MS),
            );
            continue;
          }
          throw new Error(launchError);
        }

        const transport = createHubTransport();
        transportRef.current = transport;
        const session = createInstanceSession({
          tenantId: targetTenantId,
          instanceId: targetInstanceId,
          transport,
          onChange: () => {
            if (!cancelled) forceUpdate((n) => n + 1);
          },
          onError: (err) => {
            if (!cancelled) setState({ phase: "error", message: err.message });
          },
        });

        sessionRef.current = session;
        const stop = session.start();
        stopRef.current = stop;

        // Capture tool names from the live stream so committed turns whose tool
        // "call" part failed to persist still render the real tool (CL-1398).
        toolNamesRef.current = createToolNameTracker(
          transport,
          { tenantId: targetTenantId, instanceId: targetInstanceId },
          () => {
            if (!cancelled) forceUpdate((n) => n + 1);
          },
        );

        // Track the current turn's live text from the raw stream (CL-1643).
        liveTextRef.current = createLiveTextTracker(transport, {
          tenantId: targetTenantId,
          instanceId: targetInstanceId,
        });
        reasoningRef.current = createReasoningTracker(transport, {
          tenantId: targetTenantId,
          instanceId: targetInstanceId,
        });
        imageTrackerRef.current = createImageTracker(transport, {
          tenantId: targetTenantId,
          instanceId: targetInstanceId,
        });

        if (!cancelled) setState({ phase: "ready", session });
      } catch {
        if (!cancelled) {
          setState({
            phase: "error",
            message:
              "Could not connect to Myra. Check your connection and try again.",
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
      transportRef.current = null;
      sessionRef.current?.destroy();
      sessionRef.current = null;
      const urls = attachmentUrlsRef.current;
      attachmentUrlsRef.current = new Map();
      for (const pending of urls.values()) {
        void pending.then(URL.revokeObjectURL).catch(() => {});
      }
    };
  }, [attempt, instanceId, tenantId, enabled]);

  const queryClient = useQueryClient();

  const { data: ratingsData } = useQuery({
    queryKey: ["feedback", resolvedInstanceId],
    queryFn: () => getOutputFeedback(resolvedInstanceId as string),
    enabled: resolvedInstanceId !== null,
    staleTime: 5 * 60_000,
  });

  const ratingsMap = useMemo(
    () =>
      new Map(
        (ratingsData ?? []).map((r) => [
          `${r.subjectId}:${r.subjectKind}`,
          r.rating,
        ]),
      ),
    [ratingsData],
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
      queryClient.setQueryData<SavedRating[]>(["feedback", iid], (prev) =>
        upsertRating(prev, { subjectId, subjectKind, rating }),
      );
    },
  });

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  const session = state.phase === "ready" ? state.session : null;

  const messages: ChatMessage[] = session
    ? composeChatMessages({
        events: session.events,
        streaming: liveTextRef.current !== null ? liveTextRef.current.text : "",
        reasoning:
          reasoningRef.current !== null ? reasoningRef.current.text : "",
        ...(toolNamesRef.current !== null
          ? { toolNames: toolNamesRef.current.names }
          : {}),
        ...(imageTrackerRef.current !== null &&
        imageTrackerRef.current.images.length > 0
          ? { liveImages: imageTrackerRef.current.images }
          : {}),
      }).messages
    : [];

  const activity = session ? toChatActivity(session.activity) : null;

  const sendWithAttachments = async (
    text: string,
    attachments: PendingAttachment[],
  ): Promise<void> => {
    const transport = transportRef.current;
    const iid = resolvedInstanceIdRef.current;
    if (transport === null || iid === null || tenantId === null) {
      throw new Error("Not connected yet. Try again in a moment.");
    }
    const encoded = await encodeAttachments(attachments);
    try {
      await deliverMessageWithAttachments(
        transport,
        tenantId,
        iid,
        text,
        encoded,
      );
    } catch (err) {
      throw new Error(attachmentErrorMessage(err));
    }
  };

  const send = (
    text: string,
    attachments?: PendingAttachment[],
  ): void | Promise<void> => {
    if (!session) return;
    if (attachments === undefined || attachments.length === 0) {
      void deliverMessage(session, resolvedInstanceIdRef.current, text).catch(
        () => {
          setState({
            phase: "error",
            message:
              "Could not reach Myra. Check your connection and try again.",
          });
        },
      );
      return;
    }
    // Return the promise so the composer keeps the pending files and surfaces
    // the error if the send fails, instead of clearing optimistically.
    return sendWithAttachments(text, attachments);
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

  const resolveAttachmentUrl = useCallback(
    (blobId: string): Promise<string> => {
      if (tenantId === null) {
        return Promise.reject(new Error("Not connected yet."));
      }
      const cache = attachmentUrlsRef.current;
      const existing = cache.get(blobId);
      if (existing !== undefined) return existing;
      const pending = fetchBlobObjectUrl(tenantId, blobId).catch((err) => {
        // A failed fetch must not poison the cache — drop it so a retry can
        // refetch, and rethrow so the tile falls back.
        cache.delete(blobId);
        throw err;
      });
      cache.set(blobId, pending);
      return pending;
    },
    [tenantId],
  );

  return {
    state,
    messages,
    activity,
    send,
    reconnect,
    instanceId: resolvedInstanceId,
    resolveAttachmentUrl,
    ...(onRate ? { onRate } : {}),
    ...(getRating ? { getRating } : {}),
  };
}
