// Workspace-scoped HTTP surface: CRUD over a workspace's own config
// profiles, "save current setup as a profile" (`POST /capture`), and
// "attach this profile to a workbench" (`POST /apply`). Mounted under the
// *workspace* tenant's own `${TENANT_PREFIX}` the same way
// `@corbits/preferences` and `@corbits/routines` mount their routes — but
// `/capture` and `/apply` both act on a *different*, workbench-scoped
// tenant named in the request body (`workbenchTenantId`), so they forward
// the caller's own session cookie into a self-HTTP call against that
// tenant's native catalog routes (`@corbits/inference-settings`'s
// `getResolvedCatalog`/`listOwnOfferings`/`updateOwnOffering`), the same
// seam `@workbench/access-policy`'s `POST .../child-tenants` already uses.
// That self-call is what actually enforces "can this principal write this
// workbench's catalog" — this route never re-implements that check itself.
import { Hono } from "hono";
import { type } from "arktype";

import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { idResource } from "@intx/hub-api";
import type { FetchImpl } from "@corbits/inference-settings/api";

import {
  applyProfile,
  ConfigProfileNotFoundError,
  type ApplyEntryResult,
} from "./apply";
import { captureProfileFromWorkbench } from "./capture";
import type {
  ConfigProfileEntry,
  ConfigProfileRow,
  ConfigProfileStore,
} from "./store";

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

const ConfigProfileEntryBody = type({
  provider: "string > 0",
  model: "string > 0",
  "disabled?": "boolean",
});

const CreateConfigProfileBody = type({
  name: "string > 0",
  "description?": "string",
  entries: ConfigProfileEntryBody.array(),
});

const UpdateConfigProfileBody = type({
  "name?": "string > 0",
  "description?": "string | null",
  "entries?": ConfigProfileEntryBody.array(),
});

const CaptureConfigProfileBody = type({
  workbenchTenantId: "string > 0",
  name: "string > 0",
  "description?": "string",
});

const ApplyConfigProfileBody = type({
  profileId: "string > 0",
  workbenchTenantId: "string > 0",
});

function profileView(row: ConfigProfileRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    entries: row.entries,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function cookiesFromHeader(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0);
}

/**
 * A `fetch` bound to the hub's own base URL and the acting principal's
 * session cookie, so `@corbits/inference-settings`'s api functions —
 * written for the browser, where a relative path already resolves
 * same-origin — work identically when called from this server-side
 * route. Mirrors `@workbench/hub-client`'s `createHubAPI`, just shaped as
 * a `FetchImpl` rather than an `ApiCall`, since that is what the
 * inference-settings functions this module reuses already take.
 */
function selfFetch(baseUrl: string, cookies: string[]): FetchImpl {
  return (input, init) => {
    const path =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers = new Headers(init?.headers);
    if (cookies.length > 0) headers.set("cookie", cookies.join("; "));
    return fetch(`${baseUrl}${path}`, { ...init, headers });
  };
}

export type CreateConfigProfileRoutesDeps = {
  store: ConfigProfileStore;
  requireGrant: RequireGrant;
  /** This hub's own externally-reachable base URL, for `/capture` and
   * `/apply`'s self-calls against a workbench tenant's native catalog
   * routes. */
  hubBaseUrl: string;
};

export function createConfigProfileRoutes(
  deps: CreateConfigProfileRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get("/", deps.requireGrant("config-profile:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const rows = await deps.store.listProfiles(tenant.id);
    return c.json({ items: rows.map(profileView) });
  });

  app.post("/", deps.requireGrant("config-profile:*", "create"), async (c) => {
    const body = CreateConfigProfileBody(
      await c.req.json().catch(() => undefined),
    );
    if (body instanceof type.errors) {
      return c.json(
        ErrorEnvelope("bad_request", `invalid profile: ${body.summary}`),
        400,
      );
    }
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const row = await deps.store.createProfile({
      tenantId: tenant.id,
      name: body.name,
      description: body.description ?? null,
      entries: body.entries as ConfigProfileEntry[],
      createdBy: principal.id,
    });
    return c.json(profileView(row), 201);
  });

  app.get(
    "/:id",
    deps.requireGrant(idResource("config-profile", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const row = await deps.store.getProfile(tenant.id, c.req.param("id"));
      if (row === undefined) {
        return c.json(ErrorEnvelope("not_found", "profile not found"), 404);
      }
      return c.json(profileView(row));
    },
  );

  app.patch(
    "/:id",
    deps.requireGrant(idResource("config-profile", "id"), "write"),
    async (c) => {
      const body = UpdateConfigProfileBody(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope(
            "bad_request",
            `invalid profile patch: ${body.summary}`,
          ),
          400,
        );
      }
      const tenant = c.get("tenant");
      const profileId = c.req.param("id");
      const existing = await deps.store.getProfile(tenant.id, profileId);
      if (existing === undefined) {
        return c.json(ErrorEnvelope("not_found", "profile not found"), 404);
      }
      let patch: {
        name?: string;
        description?: string | null;
        entries?: ConfigProfileEntry[];
      } = {};
      if (body.name !== undefined) patch = { ...patch, name: body.name };
      if (body.description !== undefined) {
        patch = { ...patch, description: body.description };
      }
      if (body.entries !== undefined) {
        patch = { ...patch, entries: body.entries as ConfigProfileEntry[] };
      }
      const row = await deps.store.updateProfile(tenant.id, profileId, patch);
      return c.json(profileView(row));
    },
  );

  app.delete(
    "/:id",
    deps.requireGrant(idResource("config-profile", "id"), "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const deleted = await deps.store.deleteProfile(
        tenant.id,
        c.req.param("id"),
      );
      if (!deleted) {
        return c.json(ErrorEnvelope("not_found", "profile not found"), 404);
      }
      return c.body(null, 204);
    },
  );

  app.post(
    "/capture",
    deps.requireGrant("config-profile:*", "create"),
    async (c) => {
      const body = CaptureConfigProfileBody(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope("bad_request", `invalid capture: ${body.summary}`),
          400,
        );
      }
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const cookies = cookiesFromHeader(c.req.header("cookie"));
      const row = await captureProfileFromWorkbench(
        { store: deps.store },
        {
          tenantId: tenant.id,
          workbenchTenantId: body.workbenchTenantId,
          name: body.name,
          description: body.description ?? null,
          createdBy: principal.id,
          fetchImpl: selfFetch(deps.hubBaseUrl, cookies),
        },
      );
      return c.json(profileView(row), 201);
    },
  );

  app.post(
    "/apply",
    deps.requireGrant("config-profile:*", "write"),
    async (c) => {
      const body = ApplyConfigProfileBody(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope("bad_request", `invalid apply: ${body.summary}`),
          400,
        );
      }
      const tenant = c.get("tenant");
      const cookies = cookiesFromHeader(c.req.header("cookie"));
      try {
        const result = await applyProfile(
          { store: deps.store },
          {
            tenantId: tenant.id,
            profileId: body.profileId,
            workbenchTenantId: body.workbenchTenantId,
            fetchImpl: selfFetch(deps.hubBaseUrl, cookies),
          },
        );
        return c.json({
          profileId: result.profileId,
          profileName: result.profileName,
          results: result.results as ApplyEntryResult[],
        });
      } catch (err) {
        if (err instanceof ConfigProfileNotFoundError) {
          return c.json(ErrorEnvelope("not_found", "profile not found"), 404);
        }
        throw err;
      }
    },
  );

  return app;
}
