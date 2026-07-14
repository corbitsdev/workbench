import { ApiError, type Transport } from "@intx/hub-client";
import { subscribeSharedEventStream } from "./shared-event-stream";

// Browser Transport for InstanceSession that targets the hub origin and sends
// auth cookies. Interchange's stock createBrowserTransport issues relative,
// same-origin fetch/EventSource calls with no credentials — which works only
// when the UI is served from the hub. The workbench deploys the UI and hub on
// separate origins (VITE_API_BASE_URL), so instance mail/turn/event calls must
// be pointed at the hub and carry the session cookie, mirroring hub-api.ts.

const apiBase: string = import.meta.env.VITE_API_BASE_URL ?? "";

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
  const base = import.meta.env.DEV
    ? window.location.origin
    : apiBase || window.location.origin;
  return new URL(path, base).toString();
}

// Authenticated binary GET against the hub for a stored mail-attachment blob.
// The stock transport parses JSON, so it cannot carry octet-stream bytes; this
// mirrors its URL + credentialed-cookie build and returns an object URL the
// caller owns (and must revoke). Kept here so the hub-base/cookie convention
// lives in one place.
export async function fetchBlobObjectUrl(
  tenantId: string,
  blobId: string,
): Promise<string> {
  const path = `/api/tenants/${tenantId}/agents/instances/blobs/${blobId}`;
  const res = await fetch(toUrl(path), {
    method: "GET",
    credentials: "include",
  });
  if (!res.ok) {
    throw new ApiError(res.status, "blob_fetch_failed", `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// Authenticated binary GET for a file artifact's bytes (a chat upload diverted
// through the parse-file route). Mirrors fetchBlobObjectUrl; the caller owns
// (and must revoke) the returned object URL.
export async function fetchArtifactObjectUrl(
  artifactId: string,
): Promise<string> {
  const path = `/api/v1/artifacts/${artifactId}/download`;
  const res = await fetch(toUrl(path), {
    method: "GET",
    credentials: "include",
  });
  if (!res.ok) {
    throw new ApiError(
      res.status,
      "artifact_fetch_failed",
      `HTTP ${res.status}`,
    );
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function createHubTransport(transportOpts?: {
  onStreamError?: (error: Error) => void;
}): Transport {
  return {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      const init: RequestInit = { method, credentials: "include" };
      if (body !== undefined) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(body);
      }
      const res = await fetch(toUrl(path), init);
      if (!res.ok) {
        const raw = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        throw new ApiError(
          res.status,
          raw?.error?.code ?? "unknown",
          raw?.error?.message ?? `HTTP ${res.status}`,
        );
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    },

    subscribe(
      path: string,
      onEvent: (event: unknown) => void,
      opts?: { eventName?: string },
    ): () => void {
      // Delegate to the process-wide shared stream so every consumer of this
      // agent's events (session, live-text / reasoning / phase trackers, the
      // sidebar) shares one EventSource instead of each opening its own and
      // exhausting the browser's per-origin connection cap (CL-1660 review).
      // 'message' is the default unnamed SSE event when no eventName is given.
      return subscribeSharedEventStream(
        toEventSourceUrl(path),
        opts?.eventName ?? "message",
        onEvent,
        transportOpts?.onStreamError,
      );
    },
  };
}
