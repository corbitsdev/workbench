// Shared test harness for `createPresenceRoutes`: mounts the router behind
// a fake tenant/principal-injecting middleware, mirroring the exact shape
// the hub's real `resolveTenant` middleware sets (`@corbits/chat`'s own
// `test/test-support.ts` does the same for chat routes) so route tests
// exercise the same context contract production traffic does.
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { TenantEnv } from "@intx/hub-api";

export function tenant(id: string) {
  return {
    id,
    name: id,
    slug: id,
    domain: `${id}.example`,
    parentId: null,
    config: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function principal(id: string, tenantId: string) {
  return {
    id,
    tenantId,
    kind: "user" as const,
    refId: id,
    status: "active" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function mountAs(
  routes: Hono<TenantEnv>,
  opts: { tenantId: string; principalId: string; displayName?: string },
): Hono<TenantEnv> {
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", tenant(opts.tenantId));
    c.set("principal", principal(opts.principalId, opts.tenantId));
    c.set(
      "user",
      opts.displayName === undefined
        ? null
        : {
            id: opts.principalId,
            createdAt: new Date(),
            updatedAt: new Date(),
            email: `${opts.principalId}@example.com`,
            emailVerified: true,
            name: opts.displayName,
          },
    );
    c.set("session", null);
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}
