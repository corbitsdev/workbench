import type { MiddlewareHandler } from 'hono';
import { getLogger } from '@intx/log';

const log = getLogger(['api', 'server-error']);

// Context flag set by app.onError after it logs a thrown error, so the reporter
// below does not double-report the same failure.
export const SERVER_ERROR_LOGGED = 'serverErrorLogged' as const;

type ErrorLoggedVars = { Variables: { [SERVER_ERROR_LOGGED]?: boolean } };

// Reports any >= 500 response to the error log (which routes to the Sentry
// sink), including handled errors returned via `c.json(..., 5xx)` that never
// throw and so never reach app.onError — the gap that let server faults ship
// silently. Thrown errors are still logged (with their stack) by onError, which
// sets SERVER_ERROR_LOGGED so they are not reported twice here.
export function serverErrorReporter(): MiddlewareHandler<ErrorLoggedVars> {
  return async (c, next) => {
    await next();
    if (c.res.status >= 500 && !c.get(SERVER_ERROR_LOGGED)) {
      log.error('Server error response', {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
      });
    }
  };
}
