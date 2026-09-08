import { CODEX_RESPONSES_PATH } from "./constants";

/** The `fetch` shape {@link withCodexContentTypeRepair} wraps. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function requestURL(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// Content type the request's accept header committed to, or null when the
// commitment is ambiguous. Reads init headers first, falling back to a
// Request object's own headers so both fetch calling conventions are
// honored. Media types are prefix-matched per comma-separated entry so
// parameters do not defeat the match; a list naming BOTH supported
// protocols is ambiguous and yields null.
function acceptedContentType(
  input: string | URL | Request,
  init: RequestInit | undefined,
): string | null {
  const headers =
    init?.headers !== undefined
      ? new Headers(init.headers)
      : input instanceof Request
        ? input.headers
        : undefined;
  const accept = headers?.get("accept");
  if (accept === undefined || accept === null) return null;
  const supported = new Set<string>();
  for (const entry of accept.toLowerCase().split(",")) {
    const media = entry.trim();
    if (media.startsWith("text/event-stream"))
      supported.add("text/event-stream");
    else if (media.startsWith("application/json"))
      supported.add("application/json");
  }
  if (supported.size !== 1) return null;
  return [...supported][0] ?? null;
}

/**
 * The Codex backend omits the Content-Type header entirely on some model
 * streams while the body is a valid SSE stream. A harness that detects the
 * response protocol from that header alone would fail the turn when it is
 * absent, so this fetch decorator restores it from the protocol the
 * request's accept header declared. Responses that declare any
 * Content-Type, non-2xx responses, and requests whose accept header is
 * ambiguous pass through untouched.
 */
export function withCodexContentTypeRepair(fetchImpl: FetchLike): FetchLike {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!requestURL(input).endsWith(CODEX_RESPONSES_PATH)) return response;
    if (!response.ok) return response;
    if (response.headers.get("content-type") !== null) return response;
    const declared = acceptedContentType(input, init);
    if (declared === null) return response;
    const headers = new Headers(response.headers);
    headers.set("content-type", declared);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
