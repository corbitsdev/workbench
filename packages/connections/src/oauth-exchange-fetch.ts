// Shared code-for-token/key exchange fetch for every OAuth connect
// module (github-connect.ts, gmail-connect.ts, huggingface-connect.ts,
// openrouter-connect.ts). Each posts once to its provider's token
// endpoint and must not hang forever if that provider never answers --
// this mirrors the `AbortSignal.timeout(...)` already applied to every
// outbound call in `./probes.ts`, so one shared call site replaces four
// separate copies of the same timeout wiring. The signal aborts the
// underlying request the instant the timer fires; it never races a
// timer while leaving the fetch itself running unobserved.

export const OAUTH_EXCHANGE_TIMEOUT_MS = 10_000;

export type OAuthExchangeFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

/**
 * Posts to an OAuth token/key exchange endpoint bounded by `timeoutMs`
 * (default `OAUTH_EXCHANGE_TIMEOUT_MS`). A timeout rejects the same way
 * any other network failure does, so callers keep their existing
 * catch-and-convert-to-`{ ok: false, message }` handling unchanged.
 */
export async function postExchangeRequest(
  fetchImpl: OAuthExchangeFetch,
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
  timeoutMs: number = OAUTH_EXCHANGE_TIMEOUT_MS,
): Promise<Response> {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
