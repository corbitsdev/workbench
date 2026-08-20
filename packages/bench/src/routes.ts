// Tenant-scoped bench-settings API: purpose and type for the bench itself
// (the current tenant), stored in the package-owned side-table since the
// native tenant route carries neither field.
import { Hono } from "hono";
import { type } from "arktype";

import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import type { BenchSettingsStore } from "./store";

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

// `BenchCreateType` in packages/bench-ui/src/create-bench-dialog.tsx allows
// exactly "global" | "sub" today; validated strictly here rather than as a
// bare string so a bad client can't seed the side-table with a
// classification the UI has no rendering for.
const PatchBody = type({
  "purpose?": "string",
  "type?": "'global' | 'sub'",
});

export type CreateBenchRoutesDeps = {
  store: BenchSettingsStore;
  requireGrant: RequireGrant;
};

export function createBenchRoutes(
  deps: CreateBenchRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get("/", deps.requireGrant("bench:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const settings = await deps.store.getBenchSettings(tenant.id);
    return c.json({ purpose: settings.purpose, type: settings.type });
  });

  app.patch("/", deps.requireGrant("bench:*", "write"), async (c) => {
    const tenant = c.get("tenant");

    const raw = await c.req.json().catch(() => undefined);
    const patch = PatchBody(raw);
    if (patch instanceof type.errors) {
      return c.json(
        ErrorEnvelope("bad_request", `invalid body: ${patch.summary}`),
        400,
      );
    }

    const settings = await deps.store.patchBenchSettings(tenant.id, patch);
    return c.json({ purpose: settings.purpose, type: settings.type });
  });

  return app;
}
