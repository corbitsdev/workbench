/**
 * Tenant-scoped Library L2 HTTP surface over the mounted `@corbits/artifacts`
 * engine. List (newest-first, paginated) and get-by-id only — upload/search
 * UI stays on later tickets.
 *
 * Authz uses the existing `asset` resource family so Library grants keep
 * working without inventing a parallel vocabulary.
 *
 * The store is injected so tests can exercise happy/empty/cross-tenant
 * without a live Postgres.
 */
import {
  anonymousIdentity,
  getArtifact,
  listArtifacts,
  serializeArtifact,
  serializeArtifactListItem,
  type ArtifactDb,
  type SerializedArtifact,
  type SerializedArtifactListItem,
} from "@corbits/artifacts";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { Hono } from "hono";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export type ArtifactListPage = {
  readonly data: readonly SerializedArtifactListItem[];
  readonly nextCursor: string | null;
};

/** Minimal port the routes need — production wraps the engine db. */
export type ArtifactRoutesStore = {
  list(
    tenantId: string,
    opts: { limit: number; cursor: string | null },
  ): Promise<ArtifactListPage>;
  get(tenantId: string, artifactId: string): Promise<SerializedArtifact | null>;
};

export type CreateArtifactRoutesDeps = {
  store: ArtifactRoutesStore;
  requireGrant: RequireGrant;
};

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function parseCursor(
  raw: string | undefined,
): { at: string; id: string } | undefined {
  if (raw === undefined || raw === "") return undefined;
  const sep = raw.lastIndexOf("__");
  if (sep <= 0 || sep === raw.length - 2) return undefined;
  const at = raw.slice(0, sep);
  const id = raw.slice(sep + 2);
  if (!at || !id) return undefined;
  return { at, id };
}

/** Production store over an artifacts engine db handle. */
export function createArtifactDbStore(db: ArtifactDb): ArtifactRoutesStore {
  return {
    async list(tenantId, opts) {
      const cursor = parseCursor(opts.cursor ?? undefined);
      const result = await listArtifacts(db, anonymousIdentity, tenantId, {
        limit: opts.limit,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      return {
        data: result.rows.map(serializeArtifactListItem),
        nextCursor: result.nextCursor,
      };
    },
    async get(tenantId, artifactId) {
      const row = await getArtifact(db, artifactId);
      if (row === null || row.tenantId !== tenantId) return null;
      return serializeArtifact(row);
    },
  };
}

export function createArtifactRoutes(
  deps: CreateArtifactRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get("/", deps.requireGrant("asset:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const limit = parseLimit(c.req.query("limit"));
    const cursor = c.req.query("cursor") ?? null;
    const page = await deps.store.list(tenant.id, { limit, cursor });
    return c.json(page);
  });

  app.get("/:artifactId", deps.requireGrant("asset:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const artifactId = c.req.param("artifactId");
    const row = await deps.store.get(tenant.id, artifactId);
    if (row === null) {
      return c.json(
        { error: { code: "not_found", message: "Artifact not found" } },
        404,
      );
    }
    return c.json(row);
  });

  return app;
}
