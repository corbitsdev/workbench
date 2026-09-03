// Tenant-scoped Preferences API: a single JSONB bag per (tenant, principal)
// for small UI choices a surface wants to remember across reload. Keys are
// forward-compatible free-form strings owned by whichever surface writes
// them (e.g. "shell.col2Collapsed") — this package has no opinion on their
// shape beyond "a plain JSON object".
import { Hono } from "hono";
import { type } from "arktype";

import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import type { PreferencesStore } from "./store";
import { makeErrorEnvelope } from "@corbits/error-sink";

const PatchBody = type("Record<string, unknown>");

export type CreatePreferencesRoutesDeps = {
  store: PreferencesStore;
  requireGrant: RequireGrant;
};

export function createPreferencesRoutes(
  deps: CreatePreferencesRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get("/", deps.requireGrant("preferences:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const preferences = await deps.store.getPreferences(
      tenant.id,
      principal.id,
    );
    return c.json({ preferences });
  });

  app.patch("/", deps.requireGrant("preferences:*", "write"), async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");

    const raw = await c.req.json().catch(() => undefined);
    const patch = PatchBody(raw);
    if (patch instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid body: ${patch.summary}`,
        }),
        400,
      );
    }

    const preferences = await deps.store.patchPreferences(
      tenant.id,
      principal.id,
      patch,
    );
    return c.json({ preferences });
  });

  return app;
}
