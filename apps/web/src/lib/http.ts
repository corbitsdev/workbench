// Shared low-level fetch plumbing for the web app's fetch helpers
// (api.ts /api/v1, hub-api.ts /api/, instance-transport.ts's Transport).
// Each keeps its own URL-building and error-shape rules — those diverge
// legitimately by base path and error taxonomy — but the base-URL
// resolution, credentialed JSON request init, and best-effort error-body
// parse were each duplicated three times. This is the single definition.

export const configuredApiBase: string =
  import.meta.env.VITE_API_BASE_URL ?? "";

// Empty string means same-origin (frontend served from the API).
export function resolveApiBase(): string {
  return configuredApiBase || window.location.origin;
}

export function buildJsonRequestInit(
  method: string,
  body?: unknown,
): RequestInit {
  const init: RequestInit = { method, credentials: "include" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return init;
}

// Best-effort parse of a failed response's JSON body; null when the body is
// absent or not valid JSON. Callers that need a non-null default object
// (rather than surfacing "no body") apply their own fallback on top.
export async function readJsonOrNull(res: Response): Promise<unknown> {
  return res.json().catch(() => null);
}
