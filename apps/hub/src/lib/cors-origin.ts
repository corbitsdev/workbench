/**
 * Resolve the value for the `Access-Control-Allow-Origin` header for a
 * credentialed response. Returns the request origin only when it is in the
 * allowlist; otherwise returns `undefined` so the caller omits the header
 * entirely. Never fall back to a default allowed origin: emitting a credentialed
 * ACAO for an unmatched origin trusts the browser to enforce the mismatch
 * instead of rejecting at the server boundary.
 */
export function resolveCorsAllowOrigin(
  requestOrigin: string | null | undefined,
  allowedOrigins: readonly string[],
): string | undefined {
  if (!requestOrigin) return undefined;
  return allowedOrigins.includes(requestOrigin) ? requestOrigin : undefined;
}
