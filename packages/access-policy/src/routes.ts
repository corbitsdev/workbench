// Tenant-scoped HTTP surface: reading/editing this tenant's own policy
// row, managing its pending invites, and the one gated tenant-creation
// surface — `POST .../child-tenants` — that checks `tenancyCreation`
// against the caller's native roles (read back through the native
// principal-detail route) before ever calling `POST /api/tenants`
// itself. Every native call goes through the injected `ApiCall`, the
// same self-HTTP-call seam `@workbench/onboarding` already uses —
// nothing here reimplements tenant creation or role resolution.
import { Hono } from "hono";
import { type } from "arktype";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { makeErrorEnvelope, reportError } from "@corbits/error-sink";
import { cookiesFromHeader, type ApiCall } from "@workbench/hub-client";

import { canCreateTenancy } from "./policy";
import type { AccessPolicyStore } from "./store";
import { CreatePendingInvite, UpdateAccessPolicy } from "./types";

const CreateChildTenant = type({
  name: "string > 0",
  slug: "string > 0",
});

export type CreateAccessPolicyRoutesDeps = {
  store: AccessPolicyStore;
  requireGrant: RequireGrant;
  api: ApiCall;
};

export function createAccessPolicyRoutes(
  deps: CreateAccessPolicyRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get("/", deps.requireGrant("access-policy:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const policy = await deps.store.getPolicy(tenant.id);
    return c.json(policy);
  });

  app.patch("/", deps.requireGrant("access-policy:*", "manage"), async (c) => {
    const tenant = c.get("tenant");
    const raw: unknown = await c.req.json().catch(() => undefined);
    const patch = UpdateAccessPolicy(raw);
    if (patch instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid policy: ${patch.summary}`,
        }),
        400,
      );
    }
    const updated = await deps.store.upsertPolicy(tenant.id, patch);
    return c.json(updated);
  });

  app.get(
    "/pending-invites",
    deps.requireGrant("access-policy:*", "manage"),
    async (c) => {
      const tenant = c.get("tenant");
      const invites = await deps.store.listPendingInvites(tenant.id);
      return c.json({ data: invites });
    },
  );

  app.post(
    "/pending-invites",
    deps.requireGrant("access-policy:*", "manage"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const raw: unknown = await c.req.json().catch(() => undefined);
      const parsed = CreatePendingInvite(raw);
      if (parsed instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid invite: ${parsed.summary}`,
          }),
          400,
        );
      }
      const invite = await deps.store.createPendingInvite(tenant.id, {
        ...parsed,
        invitedBy: parsed.invitedBy ?? principal.id,
      });
      return c.json(invite, 201);
    },
  );

  app.delete(
    "/pending-invites/:id",
    deps.requireGrant("access-policy:*", "manage"),
    async (c) => {
      const tenant = c.get("tenant");
      const id = c.req.param("id");
      await deps.store.deletePendingInvite(tenant.id, id);
      return c.body(null, 204);
    },
  );

  // The gated tenant-creation surface: any signed-in member of this
  // tenant may attempt it, but only one whose native roles satisfy this
  // tenant's own `tenancyCreation` mode ever reaches `POST /api/tenants`.
  app.post("/child-tenants", async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const raw: unknown = await c.req.json().catch(() => undefined);
    const body = CreateChildTenant(raw);
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid tenant: ${body.summary}`,
        }),
        400,
      );
    }

    const cookies = cookiesFromHeader(c.req.header("cookie"));
    const policy = await deps.store.getPolicy(tenant.id);

    const principalResponse = await deps.api(
      "GET",
      `/api/tenants/${tenant.id}/principals/${principal.id}`,
      undefined,
      cookies,
    );
    if (principalResponse.status !== 200) {
      const userMessage = "Could not resolve your roles on this workbench.";
      const refId = reportError(
        new Error(`principal lookup returned ${principalResponse.status}`),
        {
          operation: "accessPolicy.childTenant.roleLookup",
          tenantId: tenant.id,
          extra: { status: principalResponse.status },
        },
      );
      return c.json(
        makeErrorEnvelope({
          code: "role_lookup_failed",
          userMessage,
          refId,
        }),
        502,
      );
    }
    const roleData = principalResponse.data as {
      roles?: { name?: unknown }[];
    };
    const roleNames = (roleData.roles ?? [])
      .map((r) => r.name)
      .filter((n): n is string => typeof n === "string");

    if (!canCreateTenancy(policy, roleNames)) {
      return c.json(
        makeErrorEnvelope({
          code: "tenancy_creation_forbidden",
          userMessage:
            "This workbench's policy doesn't allow you to create a sub-workbench here.",
        }),
        403,
      );
    }

    const created = await deps.api(
      "POST",
      "/api/tenants",
      { name: body.name, slug: body.slug, parentId: tenant.id },
      cookies,
    );
    if (created.status === 201) return c.json(created.data, 201);
    if (created.status === 409) return c.json(created.data, 409);
    return c.json(created.data, 500);
  });

  return app;
}
