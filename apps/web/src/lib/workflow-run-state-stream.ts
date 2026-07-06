import { type } from "arktype";
import { logRunStateSchema, type LogRunState } from "./run-state-adapter";

// Live run-state SSE client (CL-2779). Consumes GET
// /workflow-exec/runs/:runId/state/stream, which re-folds the run's native git
// event log and emits the authoritative RunState on connect and on every new
// committed event. This replaces the old fixed-interval poll of
// /workflow-exec/runs/:runId/state, which lagged far behind actual execution
// (observed ~90s stale) and made a live run look frozen at "Setting up…".
//
// Reference-counted per stream URL, mirroring shared-event-stream.ts: a run can
// be observed by several hooks at once (the pane's `useWorkflowRunState`, its
// `useWorkflowStepOutputs`, the dock card) — they must share ONE EventSource,
// not each open their own and exhaust the browser's ~6-connection-per-origin
// cap. The connection opens on the first subscriber for a URL and closes on the
// last unsubscribe. Reconnect/backoff lives here so every listener recovers
// together.
//
// A native EventSource only auto-reconnects on a transient network drop; an HTTP
// error status (a 400 during the provisioning window, a 403/404) fails the
// connection permanently. So reconnect is implemented here with capped
// exponential backoff — bounded, self-healing, and crucially NOT a re-introduced
// fixed-interval hammer of the /state route. The provisioning 400 window
// (CL-2777) therefore backs off (1s → 30s) instead of spamming every 2s.

const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;

export interface RunStateStreamHandlers {
  // A fresh, validated RunState folded from the run's log.
  onState: (state: LogRunState) => void;
  // Fired on each connection error, carrying the running count of consecutive
  // failures (reset to 0 by any successful frame). Lets a subscriber trigger a
  // single degraded fallback after N failures without re-arming a poll.
  onError: (consecutiveErrors: number) => void;
}

interface Connection {
  source: EventSource;
  listeners: Set<RunStateStreamHandlers>;
  retryTimeout: ReturnType<typeof setTimeout> | null;
  retryDelay: number;
  consecutiveErrors: number;
  closed: boolean;
}

const connections = new Map<string, Connection>();

export function subscribeWorkflowRunStateStream(
  url: string,
  handlers: RunStateStreamHandlers,
): () => void {
  // No EventSource (SSR, a test env without the DOM API): degrade to a no-op.
  // The caller's one-shot query fetch is still the source of truth in that case.
  if (typeof EventSource === "undefined") return () => undefined;

  let connection = connections.get(url);
  if (connection === undefined) {
    connection = {
      source: openSource(url),
      listeners: new Set(),
      retryTimeout: null,
      retryDelay: INITIAL_RETRY_DELAY_MS,
      consecutiveErrors: 0,
      closed: false,
    };
    connections.set(url, connection);
  }

  connection.listeners.add(handlers);

  return () => {
    const current = connections.get(url);
    if (current === undefined) return;
    current.listeners.delete(handlers);
    if (current.listeners.size === 0) {
      current.closed = true;
      if (current.retryTimeout !== null) clearTimeout(current.retryTimeout);
      current.source.close();
      connections.delete(url);
    }
  };
}

function openSource(url: string): EventSource {
  const source = new EventSource(url, { withCredentials: true });

  // The server writes each RunState as the default unnamed SSE event, so the
  // frame arrives as "message".
  source.addEventListener("message", (event: MessageEvent) => {
    const connection = connections.get(url);
    if (connection === undefined) return;
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      // Drop a malformed frame rather than tearing the shared stream down for
      // every listener.
      return;
    }
    const parsed = logRunStateSchema(raw);
    if (parsed instanceof type.errors) return;
    connection.consecutiveErrors = 0;
    for (const listener of connection.listeners) listener.onState(parsed);
  });

  source.onopen = () => {
    const connection = connections.get(url);
    if (connection === undefined) return;
    connection.retryDelay = INITIAL_RETRY_DELAY_MS;
  };

  source.onerror = () => {
    source.close();
    const connection = connections.get(url);
    if (connection === undefined || connection.closed) return;
    connection.consecutiveErrors += 1;
    for (const listener of connection.listeners) {
      listener.onError(connection.consecutiveErrors);
    }
    connection.retryTimeout = setTimeout(() => {
      const current = connections.get(url);
      if (current === undefined || current.closed) return;
      current.retryTimeout = null;
      current.retryDelay = Math.min(current.retryDelay * 2, MAX_RETRY_DELAY_MS);
      current.source = openSource(url);
    }, connection.retryDelay);
  };

  return source;
}

// Tears down every live connection. Test-only: the registry is process-global,
// so a leaked connection would bleed across test files.
export function __resetWorkflowRunStateStreamsForTests(): void {
  for (const connection of connections.values()) {
    connection.closed = true;
    if (connection.retryTimeout !== null) clearTimeout(connection.retryTimeout);
    connection.source.close();
  }
  connections.clear();
}
