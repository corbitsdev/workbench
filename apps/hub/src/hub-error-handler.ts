// The hub's global `app.onError` handler. Without one, an exception that
// escapes a route (e.g. a routine "run now" whose definition fails to
// launch) falls through to Hono's built-in handler: a bare 500 with no
// logged trail, which is how a genuinely broken launch — a multi-step
// workflow's launch body failing to read, a definition asset that never
// materialized — stays invisible until someone reports it from the UI.
// This handler is the one place every such exception is guaranteed to be
// reported, and it maps a named consumer-facing error to a real 4xx rather
// than folding it into a generic message.
import type { Context } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { reportError } from "@corbits/error-sink";
import { makeErrorEnvelope } from "@workbench/hub-client";

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
 * `app.onError` runs for routes mounted both inside and outside the
 * platform's tenant middleware, so `c`'s `Variables` aren't statically
 * known here; this borrows the same `TenantEnv` a tenant-scoped route
 * types `c.get("tenant")` with (see `packages/access-policy/src/routes.ts`)
 * to read `tenant.id` when a tenant-scoped route set it, without claiming
 * the wider type up front.
 */
function extractTenantId(c: Context): string | undefined {
  return (c as unknown as Context<TenantEnv>).var.tenant?.id;
}

/** Builds the handler passed to `app.onError`. */
export function hubErrorHandler() {
  return (err: unknown, c: Context): Response | Promise<Response> => {
    const tenantId = extractTenantId(c);
    const refId = reportError(err, {
      operation: "hub.unhandled_route_error",
      ...(tenantId !== undefined ? { tenantId } : {}),
      extra: { path: c.req.path, method: c.req.method },
    });

    if (hasGuidance(err)) {
      const userMessage =
        err.name === "InferenceResolutionError" ? err.guidance : err.message;
      return c.json(
        makeErrorEnvelope({
          code: err.name,
          userMessage,
          refId,
        }),
        422,
      );
    }

    return c.json(
      makeErrorEnvelope({
        code: "internal_error",
        userMessage: "Something went wrong. Please try again.",
        refId,
      }),
      500,
    );
  };
}
