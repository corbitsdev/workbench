// Tenant-scoped API for the "run this workbench on its own sidecar"
// setting. Read gated separately from write, mirroring every other
// settings surface mounted alongside this one (@corbits/bench,
// @corbits/preferences).
import { Hono } from "hono";
import { type } from "arktype";

import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import type { SidecarPlacementStore } from "./store";

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

const PutBody = type({ enabled: "boolean" });

export type CreateSidecarPlacementRoutesDeps = {
  store: SidecarPlacementStore;
  requireGrant: RequireGrant;
};

export function createSidecarPlacementRoutes(
  deps: CreateSidecarPlacementRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get("/", deps.requireGrant("sidecar-placement:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const enabled = await deps.store.getEnabled(tenant.id);
    return c.json({ enabled });
  });

  app.put("/", deps.requireGrant("sidecar-placement:*", "write"), async (c) => {
    const tenant = c.get("tenant");

    const raw = await c.req.json().catch(() => undefined);
    const body = PutBody(raw);
    if (body instanceof type.errors) {
      return c.json(
        ErrorEnvelope("bad_request", `invalid body: ${body.summary}`),
        400,
      );
    }

    const enabled = await deps.store.setEnabled(tenant.id, body.enabled);
    return c.json({ enabled });
  });

  return app;
}
