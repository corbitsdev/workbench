import { ApiError, type Transport } from '@intx/hub-client';

// Browser Transport for InstanceSession that targets the hub origin and sends
// auth cookies. Interchange's stock createBrowserTransport issues relative,
// same-origin fetch/EventSource calls with no credentials — which works only
// when the UI is served from the hub. The workbench deploys the UI and hub on
// separate origins (VITE_API_BASE_URL), so instance mail/turn/event calls must
// be pointed at the hub and carry the session cookie, mirroring hub-api.ts.

const apiBase: string = import.meta.env.VITE_API_BASE_URL ?? '';

function toUrl(path: string): string {
  return new URL(path, apiBase || window.location.origin).toString();
}

// EventSource URL resolver. A credentialed cross-origin EventSource is blocked
// by Safari (ITP) and Brave (shields) — the connection opens but the browser
// never surfaces the streamed events, so live chat updates silently fail and a
// reload is required. In dev we route the stream through the same-origin Vite
// proxy instead: the auth cookie is port-agnostic, so the proxied request still
// authenticates against the hub. Regular fetch is unaffected and stays on
// apiBase. In prod there is no proxy, so fall back to apiBase like fetch.
function toEventSourceUrl(path: string): string {
  const base = import.meta.env.DEV ? window.location.origin : apiBase || window.location.origin;
  return new URL(path, base).toString();
}

export function createHubTransport(): Transport {
  return {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      const init: RequestInit = { method, credentials: 'include' };
      if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      const res = await fetch(toUrl(path), init);
      if (!res.ok) {
        const raw = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        throw new ApiError(
          res.status,
          raw?.error?.code ?? 'unknown',
          raw?.error?.message ?? `HTTP ${res.status}`
        );
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    },

    subscribe(
      path: string,
      onEvent: (event: unknown) => void,
      opts?: { eventName?: string }
    ): () => void {
      let es: EventSource;
      let retryTimeout: ReturnType<typeof setTimeout> | null = null;
      let retryDelay = 1000;
      let closed = false;
      // Consecutive connections that errored without ever opening. An auth or
      // routing failure (403/404) presents this way on every attempt — unlike a
      // dropped-but-once-open stream — so after a few we stop for good instead
      // of hammering the hub forever.
      let failedBeforeOpen = 0;
      const MAX_FAILED_BEFORE_OPEN = 3;

      function connect() {
        let opened = false;
        es = new EventSource(toEventSourceUrl(path), { withCredentials: true });
        const handler = (e: MessageEvent) => onEvent(JSON.parse(e.data));
        if (opts?.eventName) {
          es.addEventListener(opts.eventName, handler);
        } else {
          es.onmessage = handler;
        }
        es.onerror = () => {
          es.close();
          if (closed) return;
          if (!opened) {
            failedBeforeOpen += 1;
            if (failedBeforeOpen >= MAX_FAILED_BEFORE_OPEN) return;
          }
          retryTimeout = setTimeout(() => {
            retryDelay = Math.min(retryDelay * 2, 30_000);
            connect();
          }, retryDelay);
        };
        es.onopen = () => {
          opened = true;
          failedBeforeOpen = 0;
          retryDelay = 1000;
        };
      }

      connect();

      return () => {
        closed = true;
        if (retryTimeout !== null) clearTimeout(retryTimeout);
        es.close();
      };
    },
  };
}
