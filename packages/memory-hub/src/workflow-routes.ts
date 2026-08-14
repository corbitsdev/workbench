/**
 * The sanctioned path for a workflow-process child to reach the mounted
 * `@corbits/memory` plane. Mirrors `@corbits/artifacts-hub`'s
 * `createWorkflowArtifactRoutes` (CL-6000) rather than reusing
 * `@corbits/memory`'s own `registerMemoryRoutes` /
 * `/api/tenants/:tenantId/memory/*`: that surface authenticates via
 * `c.get("principal")`, set by the platform's tenant-session middleware
 * (`createResolveTenant`) for a browser/API caller — a workflow-process
 * child has no browser session, only its own sidecar bearer token and
 * run address (`BaseEnv.address`, `apps/sidecar/src/workflow-substrate-factory/step-env.ts`).
 * `@corbits/memory` is a vendored pin (never edited in this repo), so a
 * new, narrower surface is the only honest option — same seam
 * `@corbits/artifact-tools` already established for Library artifacts.
 *
 * Mounted OUTSIDE the tenant-session prefix (`TENANT_PREFIX`) for the
 * same reason `/api/workflow-artifacts` is: every request here
 * authenticates via `WorkflowRunAuthenticator` (reused from
 * `@corbits/artifacts-hub`, itself generic over "a sidecar-provisioned
 * caller acting as one resolved run's tenant + principal" — no artifact
 * coupling), never `resolveTenant` + `requireGrant`. Every read/write is
 * scoped to the authenticated run's own tenant + principal: identity
 * NEVER rides in the request body, so a model's tool arguments can never
 * name a different tenant or principal than the run's own.
 */
import { type } from "arktype";
import { Hono } from "hono";
import type {
  ResolvedWorkflowRunScope,
  WorkflowRunAuthenticator,
} from "@corbits/artifacts-hub";
import type { Memory, SearchResult, TimelineEvent } from "@corbits/memory";

const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_LIST_LIMIT = 20;

export type WorkflowMemoryEnv = {
  Variables: { workflowRunScope: ResolvedWorkflowRunScope };
};

const SearchBody = type({
  query: "string > 0",
  "limit?": "number",
  "kinds?": "string[]",
});

const AddBody = type({
  title: "string > 0",
  text: "string > 0",
  "kind?": "string > 0",
});

export type AddedMemoryEntry = {
  readonly documentId: string;
  readonly versionId: string;
};

/** Minimal port the routes need over the plane's in-process `Memory` handle. */
export type WorkflowMemoryRoutesStore = {
  search(
    scope: ResolvedWorkflowRunScope,
    input: { query: string; limit?: number; kinds?: string[] },
  ): Promise<SearchResult>;
  add(
    scope: ResolvedWorkflowRunScope,
    input: { title: string; text: string; kind?: string },
  ): Promise<AddedMemoryEntry>;
  list(
    scope: ResolvedWorkflowRunScope,
    limit: number,
  ): Promise<TimelineEvent[]>;
};

function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

/**
 * Production store over `@corbits/memory`'s in-process `Memory` handle
 * (`apps/hub/src/memory-mount.ts`'s `MemoryMountHandle.memory`) — the
 * SAME plane instance the mount's HTTP routes serve, never a second
 * connection.
 */
export function createWorkflowMemoryStore(
  memory: Pick<Memory, "search" | "add" | "list">,
): WorkflowMemoryRoutesStore {
  return {
    async search(scope, input) {
      return memory.search({
        principalId: scope.principalId,
        tenantId: scope.tenantId,
        query: input.query,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
      });
    },
    async add(scope, input) {
      const result = await memory.add({
        principalId: scope.principalId,
        tenantId: scope.tenantId,
        content: { title: input.title, text: input.text },
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
      });
      return { documentId: result.documentId, versionId: result.versionId };
    },
    async list(scope, limit) {
      return memory.list({
        principalId: scope.principalId,
        tenantId: scope.tenantId,
        limit,
      });
    },
  };
}

export type CreateWorkflowMemoryRoutesDeps = {
  authenticator: WorkflowRunAuthenticator;
  store: WorkflowMemoryRoutesStore;
};

export function createWorkflowMemoryRoutes(
  deps: CreateWorkflowMemoryRoutesDeps,
): Hono<WorkflowMemoryEnv> {
  const app = new Hono<WorkflowMemoryEnv>();

  app.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = await deps.authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        {
          error: {
            code: "unauthorized",
            message:
              "Missing or unrecognized sidecar bearer token / run address",
          },
        },
        401,
      );
    }
    c.set("workflowRunScope", scope);
    await next();
  });

  app.post("/search", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: "bad_request", message: "Invalid JSON body" } },
        400,
      );
    }
    const parsed = SearchBody(body);
    if (parsed instanceof type.errors) {
      return c.json(
        { error: { code: "bad_request", message: parsed.summary } },
        400,
      );
    }
    const result = await deps.store.search(c.get("workflowRunScope"), {
      query: parsed.query,
      limit: parsed.limit ?? DEFAULT_SEARCH_LIMIT,
      ...(parsed.kinds !== undefined ? { kinds: parsed.kinds } : {}),
    });
    return c.json({ data: result });
  });

  app.post("/add", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: "bad_request", message: "Invalid JSON body" } },
        400,
      );
    }
    const parsed = AddBody(body);
    if (parsed instanceof type.errors) {
      return c.json(
        { error: { code: "bad_request", message: parsed.summary } },
        400,
      );
    }
    // Explicit pick, never a spread of `parsed`: arktype does not strip
    // unvalidated keys, so a caller-supplied `tenantId`/`principalId` in
    // the body must never ride through to the store — attribution comes
    // only from the authenticated `workflowRunScope` above.
    const added = await deps.store.add(c.get("workflowRunScope"), {
      title: parsed.title,
      text: parsed.text,
      ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
    });
    return c.json({ data: added }, 201);
  });

  app.get("/list", async (c) => {
    const limit = parseLimit(c.req.query("limit"), DEFAULT_LIST_LIMIT);
    const data = await deps.store.list(c.get("workflowRunScope"), limit);
    return c.json({ data });
  });

  return app;
}

/**
 * Honest degraded surface when the memory plane is not mounted (no
 * `EMBED_BASE_URL`, see `apps/hub/src/memory-mount.ts`) — same
 * convention as `createUnavailableWorkflowArtifactRoutes`.
 */
export function createUnavailableWorkflowMemoryRoutes(): Hono<WorkflowMemoryEnv> {
  const app = new Hono<WorkflowMemoryEnv>();
  const unavailable = (c: {
    json: (body: unknown, status: 503) => Response | Promise<Response>;
  }) =>
    c.json(
      {
        error: {
          code: "unavailable",
          message: "Memory plane is not configured on this hub",
        },
      },
      503,
    );
  app.post("/search", unavailable);
  app.post("/add", unavailable);
  app.get("/list", unavailable);
  return app;
}
