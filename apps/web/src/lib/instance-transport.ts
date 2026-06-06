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
      const es = new EventSource(toUrl(path), { withCredentials: true });
      const handler = (e: MessageEvent) => onEvent(JSON.parse(e.data));
      if (opts?.eventName) {
        es.addEventListener(opts.eventName, handler);
      } else {
        es.onmessage = handler;
      }
      return () => es.close();
    },
  };
}
