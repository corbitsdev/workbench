import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type } from "arktype";
import { pageContextForPathname } from "../page-context";
import { invalidateMyraThreads } from "./myra-threads-cache";
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
  ChatAttachment,
  ChatMessage,
  PendingAttachment,
} from "@workbench/chat";
import {
  abortInstanceTurn,
  ensureMeSynced,
  getMailAttachmentRefs,
  getOutputFeedback,
  launchInstanceSession,
  saveMailAttachmentRefs,
  type LaunchInstanceSessionOptions,
  saveOutputFeedback,
  upsertRating,
} from "../lib/hub-api";
import type { FeedbackSubjectKind, SavedRating } from "../lib/hub-api";
import {
  createHubTransport,
  fetchArtifactObjectUrl,
  fetchBlobObjectUrl,
} from "../lib/instance-transport";
import {
  buildAttachmentRefMap,
  isMailBlobId,
  mergeAttachmentRefs,
  upsertMailAttachmentRefs,
  type MailAttachmentRef,
} from "./mail-attachment-refs";
import { classifyLaunchState } from "../components/agent-launch-helpers";
import { useReportConnectionStatus } from "./use-report-connection-status";

const LAUNCH_RETRY_DELAY_MS = 4000;

export type MyraSessionPhase =
  | { phase: "loading" }
  | { phase: "provisioning" }
  | { phase: "credential-error" }
  | { phase: "ready"; session: InstanceSession }
  // A transient connection failure — the reconnecting overlay retries this for
  // a bounded window before giving up to a manual retry.
  | { phase: "error"; message: string }
  // A non-recoverable launch failure (e.g. auth). Terminal: not auto-retried, so
  // it does not spin the reconnecting overlay (CL-3292).
  | { phase: "fatal"; message: string };

// A text send made while the sidecar was unreachable, awaiting flush on
// reconnect. `failed` is set after a delivery attempt failed. `permanent` marks
// a non-recoverable failure that must never be auto-resent — the flush skips it
// so an already-persisted message cannot be duplicated (CL-3280).
type PendingSend = {
  id: string;
  content: string;
  createdAt: string;
  failed: boolean;
  permanent: boolean;
};

// A dropped or evicted session heals with one relaunch-and-resend. A hub or
// sidecar restart leaves the instance not running, so the first send 409s
// with code "conflict"; an address evicted from the in-memory index while the
// DB still says running 502s with code "sidecar_unavailable". The hub emits
// both before persisting the mail, so a resend cannot duplicate a delivered
// message. Discriminate on the structured code where the hub sends one — a
// true gateway 502 (no code, or an unrelated code) may mean the mail was
// already accepted upstream, so it is not treated as recoverable. Bare status
// is kept only as a fallback for errors that carry no code. Recovery is
// one-shot per send.
function isRecoverableDeliveryError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.code === "conflict" || err.code === "sidecar_unavailable") {
    return true;
  }
  if (err.code !== undefined) return false;
  return err.status === 409 || err.status === 502;
}

// Send a message to Myra, recovering from a dropped session once by relaunching
// the instance session and retrying, healing it without losing the message.
export async function deliverMessage(
  session: InstanceSession,
  instanceId: string | null,
  content: string,
  launchOptions?: LaunchInstanceSessionOptions,
): Promise<void> {
  try {
    await session.sendMail(content);
  } catch (err) {
    if (isRecoverableDeliveryError(err) && instanceId !== null) {
      await launchInstanceSession(instanceId, launchOptions);
      await session.sendMail(content);
      return;
    }
    throw err;
  }
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

// A document parse failed at the /parse-file route (timeout, oversize, bad
// type, or an upstream parser error). Carries a user-facing message so it is
// not misreported as a connectivity problem by attachmentErrorMessage.
export class DocumentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentParseError";
  }
}

// The hub validates attachments at the mail route and returns structured
// AttachmentError codes. Translate them into plain-language composer errors —
// never surface the raw code (apps/web/AGENTS.md).
export function attachmentErrorMessage(err: unknown): string {
  if (err instanceof DocumentParseError) {
    return err.message;
  }
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

// POST a message to the mail route the session uses, with the one-shot relaunch
// recovery. Unlike the string-only `sendMail`, this returns the created mail's
// id so the caller can key optimistic UI (e.g. a file chip) to the transcript
// bubble that renders from that mail event. Nothing rides inline — every
// attachment is diverted through the File Parser and folded into `content` — so
// the wire `attachments` is always empty (the SendMessage schema expects the
// field present).
export async function deliverMailMessage(
  transport: Transport,
  tenantId: string,
  instanceId: string,
  content: string,
  launchOptions?: LaunchInstanceSessionOptions,
): Promise<string | null> {
  const path = `/api/tenants/${tenantId}/agents/instances/${instanceId}/mail`;
  const body = { content, attachments: [] };
  try {
    const res = await transport.fetch<{ id?: string }>("POST", path, body);
    return res?.id ?? null;
  } catch (err) {
    if (isRecoverableDeliveryError(err)) {
      await launchInstanceSession(instanceId, launchOptions);
      const res = await transport.fetch<{ id?: string }>("POST", path, body);
      return res?.id ?? null;
    }
    throw err;
  }
}

// Documents (application/pdf and any accepted non-image type) must NEVER be sent
// inline to Myra — her openai-compatible adapter throws on document content
// blocks. They go through the hub parse route, which stores the file as an
// artifact and returns its extracted text.
const ParseFileResponse = type({
  artifactId: "string",
  filename: "string",
  parsedText: "string",
});
export type ParsedDocument = typeof ParseFileResponse.infer;

function parseFailureMessage(err: ApiError): string {
  if (err.status === 504) {
    return "The document took too long to read. Try again.";
  }
  if (err.status === 413) {
    return "That document is too large to read (10 MB max).";
  }
  if (err.status === 415) {
    return "That document type can't be read.";
  }
  if (err.status === 502) {
    return "Could not connect to the document reader. Try again.";
  }
  return "That document couldn't be read. Try again.";
}

export async function parseDocumentAttachment(
  transport: Transport,
  instanceId: string,
  doc: { filename: string; mimeType: string; data: string },
): Promise<ParsedDocument> {
  const path = `/api/v1/instances/${instanceId}/parse-file`;
  let res: unknown;
  try {
    res = await transport.fetch<unknown>("POST", path, doc);
  } catch (err) {
    if (err instanceof ApiError) {
      throw new DocumentParseError(parseFailureMessage(err));
    }
    throw err;
  }
  const parsed = ParseFileResponse(res);
  if (parsed instanceof type.errors) {
    throw new DocumentParseError("That document couldn't be read. Try again.");
  }
  return parsed;
}

// Fold the parsed document text into a leading <context> block. The adapter's
// stripContextBlock removes a leading <context>…</context> from the user's
// rendered bubble, so Myra receives the full text while the transcript stays
// clean and shows the document as a chip instead of a wall of text.
export function composeWithDocumentContext(
  text: string,
  docs: readonly ParsedDocument[],
): string {
  if (docs.length === 0) return text;
  const blocks = docs
    .map((d) => `[Attached document: ${d.filename}]\n${d.parsedText}`)
    .join("\n\n");
  const trimmed = text.trim();
  return `<context>\n${blocks}\n</context>${trimmed !== "" ? `\n\n${trimmed}` : ""}`;
}

// The per-session stream trackers, built together and torn down together.
// Tool names feed committed turns whose tool "call" part failed to persist
// (CL-1398); live text/reasoning/images track the current turn from the raw
// stream (CL-1643). Only the tool-name tracker takes a change callback.
function createSessionTrackers(
  transport: Transport,
  target: { tenantId: string; instanceId: string },
  onChange: () => void,
) {
  return {
    toolNames: createToolNameTracker(transport, target, onChange),
    liveText: createLiveTextTracker(transport, target),
    reasoning: createReasoningTracker(transport, target),
    image: createImageTracker(transport, target),
  };
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
  /**
   * Whether a live agent session is currently connected. History (from the DB)
   * renders regardless; `live` is false while the sidecar is unreachable, during
   * which sends are queued and flushed on reconnect rather than failing.
   */
  live: boolean;
  /** A queued send failed transiently and is awaiting a retry on reconnect. */
  queuedFailed: boolean;
  /**
   * Why the live connection is not up while the transcript is shown, so the UI
   * can explain the deferred-send state with the right copy: `"connecting"` on a
   * never-yet-live first connect, `"reconnecting"` after a live session drops,
   * `null` once live.
   */
  connectionNotice: "connecting" | "reconnecting" | null;
  /**
   * Interchange agent session id from the latest successful launch. Used to
   * scope Action Requests (ReviewGate) to this chat rather than the whole
   * tenant (CL-3286). Null until launch returns a session id.
   */
  sessionId: string | null;
  send: (
    text: string,
    attachments?: PendingAttachment[],
  ) => void | Promise<void>;
  /**
   * Stops the in-flight turn server-side. Resolves once the sidecar has
   * settled the turn (the conversation stays usable); rejects with a
   * user-facing message on failure.
   */
  abortTurn: () => Promise<void>;
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
  const location = useLocation();
  const instanceLaunchOptions = useMemo(
    (): LaunchInstanceSessionOptions => ({
      pageContext: pageContextForPathname(location.pathname),
    }),
    [location.pathname],
  );
  const launchOptionsRef = useRef(instanceLaunchOptions);
  launchOptionsRef.current = instanceLaunchOptions;

  const [state, setState] = useState<MyraSessionPhase>({ phase: "loading" });
  // Reset phase to `loading` during render when the identity (instanceId or
  // tenantId) changes, so `identityKey` (derived below) and `state.phase`
  // land in the same commit — a stale `ready` from the previous identity
  // never reaches useReportConnectionStatus, which otherwise saw a one-render
  // mismatch on a thread switch (CL-3155).
  const [prevIdentity, setPrevIdentity] = useState({ instanceId, tenantId });
  // A live agent session is connected (sidecar reachable). False while
  // reconnecting; history still renders and sends are queued (CL-3280).
  const [live, setLive] = useState(false);
  // Whether this thread has ever reached a live session. Distinguishes a normal
  // first-connect window (`ready` but not yet `live`) — where "reconnecting"
  // copy would be wrong — from a genuine drop after a live session (CL-3280).
  const [hasBeenLive, setHasBeenLive] = useState(false);
  // Interchange session id from launch — scopes ReviewGate to this chat (CL-3286).
  const [sessionId, setSessionId] = useState<string | null>(null);
  // The sidecar settles an aborted turn by putting the agent to sleep, which
  // emits no further agent events — the live activity signal would otherwise
  // linger as "thinking" forever. Suppress it locally after a successful
  // abort. The suppression clears on the next send AND on the first
  // genuinely-new activity event (compared by identity against the value
  // captured at abort time), so a new turn started elsewhere — e.g. a
  // parked-mail replay wake — is never hidden and the stop button stays
  // reachable.
  const [activitySuppressed, setActivitySuppressed] = useState(false);
  const suppressedActivityRef = useRef<AgentActivity | null>(null);
  // Text sends made while not `live`, replayed in order once the session
  // reconnects; and the last history snapshot, kept on screen across the brief
  // teardown that precedes a reconnect.
  const pendingQueueRef = useRef<PendingSend[]>([]);
  const lastMessagesRef = useRef<ChatMessage[]>([]);
  if (
    prevIdentity.instanceId !== instanceId ||
    prevIdentity.tenantId !== tenantId
  ) {
    setPrevIdentity({ instanceId, tenantId });
    setState({ phase: "loading" });
    setLive(false);
    setHasBeenLive(false);
    setSessionId(null);
    setActivitySuppressed(false);
    // Drop the previous thread's queued sends and history snapshot so a new
    // thread never renders the old one's messages (CL-3280).
    pendingQueueRef.current = [];
    lastMessagesRef.current = [];
  }
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

  // Monotonic id source for optimistic pending bubbles.
  const pendingSeqRef = useRef(0);
  // Ids currently being delivered by a flush. Shared across connect effects so a
  // reconnect's flush cannot re-send an item whose delivery from a prior connect
  // is still in flight (CL-3280).
  const inFlightSendIdsRef = useRef<Set<string>>(new Set());

  // Debounced full-reconnect (session teardown + re-hydrate + relaunch). A dead
  // SSE stream cannot resume without a fresh `session.start()`, so recovery is a
  // full reconnect rather than a bare relaunch; debounced to avoid a tight loop.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);
  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current !== null) return;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      setAttempt((n) => n + 1);
    }, LAUNCH_RETRY_DELAY_MS);
  }, []);

  // Stops and clears every live-connection resource (SSE subscription,
  // trackers, transport, session). Closes over only stable refs.
  const teardownSubscriptions = useCallback(() => {
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
  }, []);

  // The shared reaction to a recoverable delivery failure or dropped stream:
  // mark the session not live (history stays on screen, sends queue) and
  // debounce a full reconnect.
  const markDisconnectedAndReconnect = useCallback(() => {
    setLive(false);
    scheduleReconnect();
  }, [scheduleReconnect]);

  const enqueueSend = useCallback(
    (content: string, opts?: { failed?: boolean; permanent?: boolean }) => {
      const id = `pending-${pendingSeqRef.current++}`;
      pendingQueueRef.current = [
        ...pendingQueueRef.current,
        {
          id,
          content,
          createdAt: new Date().toISOString(),
          failed: opts?.failed ?? false,
          permanent: opts?.permanent ?? false,
        },
      ];
      forceUpdate((n) => n + 1);
    },
    [],
  );

  // Attachment chips render from persisted mail-attachment references (the
  // query below), for live sends and reloads alike — a just-sent chip is
  // upserted into the query cache so both paths render identically.
  // `docChipUrlsRef` holds an object URL built from the original File at send
  // time so a fresh chip's download needs no server round-trip; it is cleared
  // and revoked on session teardown (reloads resolve via the artifact route).
  const docChipUrlsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    // Connect only once the caller has resolved a concrete thread instance.
    // Connecting on a fallback id before the thread list loads caused a wasted
    // launch + a flash back to `loading`, then a churn to the real instance.
    if (!enabled || !instanceId || !tenantId) return;
    let cancelled = false;

    const targetInstanceId = instanceId;
    const targetTenantId = tenantId;

    // The live stream or a hydration read died. Tear down the dead
    // subscriptions so nothing leaks, keep whatever loaded on screen, and
    // reconnect rather than dropping the transcript (CL-3280).
    function handleConnectionLoss() {
      if (cancelled) return;
      teardownSubscriptions();
      markDisconnectedAndReconnect();
    }

    // Replay queued sends in order once a live session is back. `flushing` is an
    // effect-local guard (not a hook ref) so a flush wedged on a hung send in a
    // prior connect can never block this connect's flush. Permanent (non-
    // recoverable) failures are skipped, never auto-resent; a transient flush
    // failure marks the item failed and reconnects to retry — no silent drop.
    let flushing = false;
    async function flushQueue() {
      if (flushing) return;
      flushing = true;
      // Clear only transient failure marks so a retry shows as sending again;
      // permanent failures keep their failed state and are not retried.
      if (pendingQueueRef.current.some((q) => q.failed && !q.permanent)) {
        pendingQueueRef.current = pendingQueueRef.current.map((q) =>
          q.failed && !q.permanent ? { ...q, failed: false } : q,
        );
        forceUpdate((n) => n + 1);
      }
      try {
        while (!cancelled) {
          const item = pendingQueueRef.current.find(
            (q) => !q.permanent && !inFlightSendIdsRef.current.has(q.id),
          );
          const session = sessionRef.current;
          if (session === null || item === undefined) break;
          inFlightSendIdsRef.current.add(item.id);
          let outcome: "delivered" | "recoverable" | "permanent";
          try {
            await deliverMessage(
              session,
              targetInstanceId,
              item.content,
              launchOptionsRef.current,
            );
            outcome = "delivered";
          } catch (err) {
            if (cancelled) {
              // This effect was torn down mid-send (its session destroyed). The
              // throw is teardown noise, not a real delivery verdict — leave the
              // item queued for the new connect's flush to own, rather than
              // misclassifying it as permanently failed (CL-3280).
              break;
            }
            outcome = isRecoverableDeliveryError(err)
              ? "recoverable"
              : "permanent";
          } finally {
            inFlightSendIdsRef.current.delete(item.id);
          }
          if (outcome === "delivered") {
            pendingQueueRef.current = pendingQueueRef.current.filter(
              (q) => q.id !== item.id,
            );
            forceUpdate((n) => n + 1);
            invalidateMyraThreads(queryClient, targetTenantId);
            continue;
          }
          if (outcome === "recoverable") {
            // The connection dropped mid-flush: keep the item queued and
            // reconnect to retry it.
            pendingQueueRef.current = pendingQueueRef.current.map((q) =>
              q.id === item.id ? { ...q, failed: true } : q,
            );
            markDisconnectedAndReconnect();
            forceUpdate((n) => n + 1);
            break;
          }
          // Non-recoverable: the mail may already be persisted upstream, so
          // never resend it — mark it permanently failed and move on to the
          // next queued item (CL-3280).
          pendingQueueRef.current = pendingQueueRef.current.map((q) =>
            q.id === item.id ? { ...q, failed: true, permanent: true } : q,
          );
          forceUpdate((n) => n + 1);
        }
      } finally {
        flushing = false;
      }
    }

    // Bring up the live agent connection in the background. History has already
    // hydrated by the time this runs, so a launch failure keeps the transcript
    // on screen and schedules a reconnect instead of erroring (CL-3280).
    async function establishLive() {
      try {
        const launch = await launchInstanceSession(
          targetInstanceId,
          launchOptionsRef.current,
        );
        if (cancelled) return;
        if (launch.launched) {
          if (
            typeof launch.sessionId === "string" &&
            launch.sessionId.length > 0
          ) {
            setSessionId(launch.sessionId);
          }
          // The stream may have dropped during the launch window, in which case
          // handleConnectionLoss already tore the session down and scheduled a
          // reconnect. Don't mark a now-dead session live or clear that timer —
          // let the reconnect rebuild it (CL-3280). sessionId is still captured
          // above so ReviewGate stays scoped across reconnect (CL-3286).
          if (sessionRef.current === null) {
            scheduleReconnect();
            return;
          }
          clearReconnectTimer();
          setLive(true);
          setHasBeenLive(true);
          void flushQueue();
          return;
        }
        const launchError =
          launch.launchError ?? "Failed to launch Myra session";
        const classified = classifyLaunchState(undefined, launchError);
        if (classified.kind === "missing-config") {
          // A genuine config problem, not a transient outage: surface the
          // actionable setup notice and tear down the live subscriptions we
          // opened (the credential-error surface hides history anyway).
          teardownSubscriptions();
          setLive(false);
          setState({ phase: "credential-error" });
          return;
        }
        if (classified.kind === "fatal") {
          // A non-recoverable, non-transient launch failure (e.g. an auth
          // error) is by definition not an outage — surface a terminal `fatal`
          // state and tear down, instead of reconnecting forever. `fatal` (not
          // `error`) so the reconnecting overlay does not auto-retry it (CL-3292).
          teardownSubscriptions();
          setLive(false);
          setState({ phase: "fatal", message: classified.message });
          return;
        }
        scheduleReconnect();
      } catch {
        if (!cancelled) scheduleReconnect();
      }
    }

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

        // Open the session first so history hydrates from the DB (mail + turns)
        // regardless of whether the sidecar is reachable. A dropped live stream
        // tears down the dead subscriptions but keeps the transcript on screen
        // and reconnects, rather than blanking to an error (CL-3280).
        const transport = createHubTransport({
          onStreamError: handleConnectionLoss,
        });
        transportRef.current = transport;
        const session = createInstanceSession({
          tenantId: targetTenantId,
          instanceId: targetInstanceId,
          transport,
          onChange: () => {
            if (!cancelled) forceUpdate((n) => n + 1);
          },
          onError: handleConnectionLoss,
        });

        sessionRef.current = session;
        const stop = session.start();
        stopRef.current = stop;

        const trackers = createSessionTrackers(
          transport,
          { tenantId: targetTenantId, instanceId: targetInstanceId },
          () => {
            if (!cancelled) forceUpdate((n) => n + 1);
          },
        );
        toolNamesRef.current = trackers.toolNames;
        liveTextRef.current = trackers.liveText;
        reasoningRef.current = trackers.reasoning;
        imageTrackerRef.current = trackers.image;

        if (!cancelled) setState({ phase: "ready", session });

        void establishLive();
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
      clearReconnectTimer();
      teardownSubscriptions();
      const urls = attachmentUrlsRef.current;
      attachmentUrlsRef.current = new Map();
      for (const pending of urls.values()) {
        void pending.then(URL.revokeObjectURL).catch(() => {});
      }
      const chipUrls = docChipUrlsRef.current;
      docChipUrlsRef.current = new Map();
      for (const url of chipUrls.values()) {
        URL.revokeObjectURL(url);
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

  // Persisted attachment references for this instance's mails. A just-sent
  // chip is upserted into this cache by sendWithAttachments, so live and
  // reloaded transcripts render from the same source.
  const { data: attachmentRefs } = useQuery({
    queryKey: ["mail-attachments", resolvedInstanceId],
    queryFn: () => getMailAttachmentRefs(resolvedInstanceId as string),
    enabled: resolvedInstanceId !== null,
    staleTime: 5 * 60_000,
  });
  const attachmentRefMap = useMemo(
    () => buildAttachmentRefMap(attachmentRefs ?? []),
    [attachmentRefs],
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

  const { mutateAsync: abortMutateAsync } = useMutation({
    mutationFn: (iid: string) => abortInstanceTurn(iid),
  });
  const abortTurn = useCallback(async (): Promise<void> => {
    const iid = resolvedInstanceIdRef.current;
    if (iid === null) {
      throw new Error("Not connected yet. Try again in a moment.");
    }
    try {
      await abortMutateAsync(iid);
    } catch (err) {
      const message =
        err instanceof Error && err.message.trim().length > 0
          ? err.message
          : "Couldn't stop Myra. Try again.";
      throw new Error(message);
    }
    suppressedActivityRef.current = sessionRef.current?.activity ?? null;
    setActivitySuppressed(true);
  }, [abortMutateAsync]);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  // Feed this session's phase to the app-level reconnecting overlay so a
  // hub/sidecar restart covers the app instead of dropping to a "Try again".
  // Keyed by identity so switching threads (a new instance) is not misread as a
  // dropped session.
  useReportConnectionStatus(
    state.phase,
    enabled,
    reconnect,
    instanceId !== null && tenantId !== null
      ? `${tenantId}:${instanceId}`
      : null,
  );

  // Read from the ref, not `state.session`: on a dropped stream the session is
  // torn down (ref nulled) while the phase stays `ready`, so history falls back
  // to the last snapshot instead of blanking (CL-3280).
  const activeSession = state.phase === "ready" ? sessionRef.current : null;

  const composed: ChatMessage[] = activeSession
    ? composeChatMessages({
        events: activeSession.events,
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

  if (state.phase === "ready" && composed.length > 0) {
    lastMessagesRef.current = composed;
  }
  // While ready, keep the last history on screen through the brief teardown that
  // precedes a reconnect; outside ready, show nothing (a thread switch must not
  // flash the previous thread's messages).
  const baseMessages: ChatMessage[] =
    state.phase === "ready" && composed.length === 0
      ? lastMessagesRef.current
      : composed;

  // Merge persisted attachment references onto the bubble that renders from
  // the mail they were sent with, so the user sees the document they attached
  // even though it was diverted through the parse route rather than sent as a
  // mail blob — and still sees it after a reload (CL-3671).
  const mergedMessages: ChatMessage[] = mergeAttachmentRefs(
    baseMessages,
    attachmentRefMap,
  );

  // Optimistic bubbles for sends queued while disconnected; removed as each
  // flushes and the real mail event renders in its place (CL-3280).
  const pendingMessages: ChatMessage[] = pendingQueueRef.current.map((q) => ({
    id: q.id,
    role: "user",
    content: q.content,
    createdAt: q.createdAt,
    status: q.failed ? "failed" : "sending",
  }));
  const messages: ChatMessage[] = [...mergedMessages, ...pendingMessages];
  // Only transient failures are retryable; a permanent failure will not resend,
  // so it must not drive the "Retry now" affordance (CL-3280).
  const queuedFailed = pendingQueueRef.current.some(
    (q) => q.failed && !q.permanent,
  );
  // While the transcript is shown but the live connection is not up, explain the
  // deferred-send state: a drop after a live session is "reconnecting"; a
  // never-yet-live first connect is "connecting" (CL-3280, CL-3292).
  let connectionNotice: "connecting" | "reconnecting" | null = null;
  if (!live) {
    connectionNotice = hasBeenLive ? "reconnecting" : "connecting";
  }

  // Render-phase adjustment (same pattern as prevIdentity above): the first
  // activity value that differs from the one captured at abort time is a new
  // turn — stop hiding it.
  const rawActivity = activeSession ? activeSession.activity : null;
  if (activitySuppressed && rawActivity !== suppressedActivityRef.current) {
    setActivitySuppressed(false);
  }
  const suppressed =
    activitySuppressed && rawActivity === suppressedActivityRef.current;
  const activity =
    activeSession && !suppressed ? toChatActivity(rawActivity) : null;

  const sendWithAttachments = async (
    text: string,
    attachments: PendingAttachment[],
  ): Promise<void> => {
    const transport = transportRef.current;
    const iid = resolvedInstanceIdRef.current;
    if (transport === null || iid === null || tenantId === null) {
      throw new Error("Not connected yet. Try again in a moment.");
    }
    // Every attachment — images and documents alike — is diverted through the
    // File Parser. Myra's model (kimi) cannot read either inline: her
    // openai-compatible endpoint 400s on image_url parts and throws on document
    // blocks. The parser stores each as an artifact and returns extracted text,
    // which is folded into a leading <context> block so Myra receives it as
    // text regardless of her own model's modality (CL image-upload 400 fix).
    let content = text;
    let chips: ChatAttachment[] = [];
    let chipUrls: { blobId: string; url: string }[] = [];
    if (attachments.length > 0) {
      let parsedDocs: ParsedDocument[];
      try {
        parsedDocs = await Promise.all(
          attachments.map(async (a) => {
            const data = await fileToBase64(a.file);
            return parseDocumentAttachment(transport, iid, {
              filename: a.name,
              mimeType: a.mimeType,
              data,
            });
          }),
        );
      } catch (err) {
        throw new Error(attachmentErrorMessage(err));
      }
      content = composeWithDocumentContext(text, parsedDocs);
      chips = parsedDocs.map((doc, i) => ({
        blobId: doc.artifactId,
        name: doc.filename,
        type: attachments[i]!.mimeType,
        size: attachments[i]!.file.size,
      }));
      // Register each object URL in the revocable ref at creation, not after the
      // send resolves — otherwise an unmount during the send leaves the URL held
      // only in this closure and it is never revoked (the teardown revokes the
      // ref's contents). The non-success paths below delete + revoke.
      chipUrls = parsedDocs.map((doc, i) => {
        const url = URL.createObjectURL(attachments[i]!.file);
        docChipUrlsRef.current.set(doc.artifactId, url);
        return { blobId: doc.artifactId, url };
      });
    }

    const releaseChipUrls = () => {
      for (const { blobId, url } of chipUrls) {
        docChipUrlsRef.current.delete(blobId);
        URL.revokeObjectURL(url);
      }
    };

    try {
      // Nothing rides inline anymore — the parsed text is in `content`.
      const mailId = await deliverMailMessage(
        transport,
        tenantId,
        iid,
        content,
        launchOptionsRef.current,
      );
      if (chips.length > 0 && mailId !== null) {
        const refs: MailAttachmentRef[] = chips.map((c) => ({
          mailId,
          artifactId: c.blobId,
          name: c.name,
          type: c.type,
          size: c.size,
        }));
        // Seed the cache first so the chip renders immediately, then persist.
        // The message itself was already delivered, so a failed persist must
        // not fail the send — the chip stays for this session and is simply
        // absent after reload.
        queryClient.setQueryData<MailAttachmentRef[]>(
          ["mail-attachments", iid],
          (prev) => upsertMailAttachmentRefs(prev, refs),
        );
        try {
          await saveMailAttachmentRefs(
            iid,
            mailId,
            chips.map((c) => ({
              artifactId: c.blobId,
              name: c.name,
              type: c.type,
              size: c.size,
            })),
          );
        } catch {
          // Persistence failure only: the optimistic cache entry above keeps
          // the chip visible for this session.
        }
      } else {
        releaseChipUrls();
      }
      // Reorder the thread list to reflect the fresh activity, as the text-only
      // send path does above.
      invalidateMyraThreads(queryClient, tenantId);
    } catch (err) {
      releaseChipUrls();
      throw new Error(attachmentErrorMessage(err));
    }
  };

  const send = (
    text: string,
    attachments?: PendingAttachment[],
  ): void | Promise<void> => {
    // A new turn is starting — let its real activity events drive the busy
    // indicator again after an earlier abort suppressed a stale one.
    setActivitySuppressed(false);
    const hasAttachments = attachments !== undefined && attachments.length > 0;
    if (hasAttachments) {
      // Attachments are not queued in v1 — they need the parse/mail transport,
      // which requires a live session. Surface a plain message rather than a
      // failed upload while reconnecting.
      if (!live) {
        return Promise.reject(
          new Error(
            "Reconnecting to Myra — you can send files once it's back.",
          ),
        );
      }
      // Return the promise so the composer keeps the pending files and surfaces
      // the error if the send fails, instead of clearing optimistically.
      return sendWithAttachments(text, attachments);
    }

    const session = sessionRef.current;
    if (!live || session === null) {
      // Offline: show an optimistic bubble now; the queue flushes on reconnect.
      enqueueSend(text);
      scheduleReconnect();
      return;
    }
    void deliverMessage(
      session,
      resolvedInstanceIdRef.current,
      text,
      launchOptionsRef.current,
    )
      .then(() => {
        // The hub bumped this thread's lastActivityAt; refresh the list so it
        // reorders to the top rather than waiting for the query to go stale.
        invalidateMyraThreads(queryClient, tenantId);
      })
      .catch((err: unknown) => {
        // A recoverable failure (the hub emits its structured code before
        // persisting the mail, so a resend cannot duplicate) is re-queued and
        // flushed on reconnect. Any other failure is shown as a permanently
        // failed bubble and never auto-resent — the mail may already be
        // persisted upstream, so a blind retry could duplicate it (CL-3280).
        if (isRecoverableDeliveryError(err)) {
          enqueueSend(text);
          markDisconnectedAndReconnect();
        } else {
          enqueueSend(text, { failed: true, permanent: true });
        }
      });
    return;
  };

  const onRate =
    resolvedInstanceId !== null
      ? (subjectId: string, subjectKind: FeedbackSubjectKind, rating: 1 | -1) =>
          rateMutateAsync({
            instanceId: resolvedInstanceId,
            subjectId,
            subjectKind,
            rating,
          }).catch(() => {})
      : undefined;

  const getRating =
    resolvedInstanceId !== null
      ? (subjectId: string, subjectKind: FeedbackSubjectKind) =>
          ratingsMap.get(`${subjectId}:${subjectKind}`) ?? null
      : undefined;

  const resolveAttachmentUrl = useCallback(
    (blobId: string): Promise<string> => {
      // Optimistic document chips resolve to an in-memory object URL built from
      // the original File at send time — no server round-trip needed.
      const chipUrl = docChipUrlsRef.current.get(blobId);
      if (chipUrl !== undefined) return Promise.resolve(chipUrl);
      if (tenantId === null) {
        return Promise.reject(new Error("Not connected yet."));
      }
      const cache = attachmentUrlsRef.current;
      const existing = cache.get(blobId);
      if (existing !== undefined) return existing;
      // Interchange MIME-part blob ids resolve via the mail-blob route;
      // anything else is a parse-file artifact id and resolves via the
      // workbench artifact download route (persisted chips after reload).
      const fetchUrl = isMailBlobId(blobId)
        ? fetchBlobObjectUrl(tenantId, blobId)
        : fetchArtifactObjectUrl(blobId);
      const pending = fetchUrl.catch((err) => {
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
    live,
    queuedFailed,
    connectionNotice,
    sessionId,
    send,
    abortTurn,
    reconnect,
    instanceId: resolvedInstanceId,
    resolveAttachmentUrl,
    ...(onRate ? { onRate } : {}),
    ...(getRating ? { getRating } : {}),
  };
}
