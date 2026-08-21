// The hub's global `app.onError` handler. Without one, an exception that
// escapes a route (e.g. a routine "run now" whose definition fails to
// launch) falls through to Hono's built-in handler: a bare 500 with no
// logged trail, which is how a genuinely broken launch — a multi-step
// workflow's launch body failing to read, a definition asset that never
// materialized — stays invisible until someone reports it from the UI.
// This handler is the one place every such exception is guaranteed to be
// logged, and it maps a named consumer-facing error to a real 4xx rather
// than folding it into a generic message.
import type { Context } from "hono";
import { getLogger } from "@intx/log";

/**
 * Duck-typed rather than an `instanceof` allowlist: any error carrying a
 * string `guidance` alongside its `message` is a named, consumer-facing
 * failure the thrower already wrote for a human to read — see
 * `@corbits/folded-runs`'s `DefinitionProjectionMissingError` and
 * `MultiStepFoldUnsupportedError`. Its `message` is safe to return
 * verbatim; anything else is a platform fault whose internals must not
 * leak to a client.
 */
function hasGuidance(err: unknown): err is Error & { guidance: string } {
  return (
    err instanceof Error &&
    "guidance" in err &&
    typeof (err as { guidance: unknown }).guidance === "string"
  );
}

/**
 * Builds the handler passed to `app.onError`. Takes the logger as a
 * parameter (rather than constructing one internally) so a test can
 * inject a fake and assert on what got logged.
 */
export function hubErrorHandler(log: ReturnType<typeof getLogger>) {
  return (err: unknown, c: Context): Response | Promise<Response> => {
    const message = err instanceof Error ? err.message : String(err);
    log.error`Unhandled error on ${c.req.method} ${c.req.path}: ${message}`;

    if (hasGuidance(err)) {
      return c.json({ error: { code: err.name, message: err.message } }, 422);
    }

    return c.json(
      {
        error: {
          code: "internal_error",
          message: "Something went wrong. Please try again.",
        },
      },
      500,
    );
  };
}
