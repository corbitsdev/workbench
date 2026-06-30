import type { MiddlewareHandler } from "hono";
import { getLogger } from "@intx/log";

const log = getLogger(["api", "server-error"]);

// Context flag set by app.onError after it logs a thrown error, so the reporter
// below does not double-report the same failure.
export const SERVER_ERROR_LOGGED = "serverErrorLogged" as const;

type ErrorLoggedVars = { Variables: { [SERVER_ERROR_LOGGED]?: boolean } };

// Reports any >= 500 response to the error log (which routes to the Sentry
// sink), including handled errors returned via `c.json(..., 5xx)` that never
// throw and so never reach app.onError — the gap that let server faults ship
// silently. Thrown errors are still logged (with their stack) by onError, which
// sets SERVER_ERROR_LOGGED so they are not reported twice here.
async function readLaunchFailureFromResponse(
  res: Response,
): Promise<string | undefined> {
  try {
    const body: unknown = await res.clone().json();
    if (body === null || typeof body !== "object") return undefined;
    const record = body as Record<string, unknown>;
    const detail = record.detail;
    if (typeof detail !== "string" || detail.length === 0) return undefined;
    const phase = typeof record.phase === "string" ? record.phase : "unknown";
    return `phase=${phase}: ${detail}`;
  } catch {
    return undefined;
  }
}

export function serverErrorReporter(): MiddlewareHandler<ErrorLoggedVars> {
  return async (c, next) => {
    await next();
    if (c.res.status >= 500 && !c.get(SERVER_ERROR_LOGGED)) {
      const launchHint = await readLaunchFailureFromResponse(c.res);
      const message =
        launchHint !== undefined
          ? `Server error response (${launchHint})`
          : "Server error response";
      log.error(message, {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
      });
    }
  };
}
