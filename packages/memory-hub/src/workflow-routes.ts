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
import { makeErrorEnvelope } from "@workbench/hub-client";
import type {
  ResolvedWorkflowRunScope,
  WorkflowRunAuthenticator,
} from "@corbits/artifacts-hub";
import type { Memory, SearchResult, TimelineEvent } from "@corbits/memory";

const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_LIST_LIMIT = 20;

// A memory entry is a durable note, not a document store — 64k
// characters is generous for any honest note while still catching a
// model that pastes an entire tool result or file verbatim instead of
// summarizing it. Mirrors `@corbits/artifacts-hub`'s upload size caps
// (`./routes.ts`'s `MAX_UPLOAD_BYTES`) in spirit: a bound stated here,
// in the package, not left to the caller's judgment.
const MAX_ADD_TEXT_CHARS = 64_000;

// A finalized turn can legitimately record a handful of memory entries
// (one per persisted artifact, plus a digest) in one burst; 30/minute
// per run comfortably covers that while still catching a runaway loop
// that would otherwise flood the memory plane's storage before a human
// notices.
const MAX_ADDS_PER_RUN_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60_000;

/**
 * In-process sliding-window rate limiter, closed over per
 * `createWorkflowMemoryRoutes` call — resets on hub restart, which is
 * fine: unlike the durable redelivery-dedup claim (`@corbits/chat`'s
 * `WriteClaimStore`), a rate bound only needs to hold within one
 * process's uptime, never across it. Per-process also means per-replica:
 * N hub replicas give one run an effective N × `MAX_ADDS_PER_RUN_PER_MINUTE`
 * budget, since each replica counts only what it personally handled —
 * a known fail-open gap, not a fail-closed one, so it under-limits rather
 * than wrongly rejecting a caller a sibling replica hasn't seen yet.
 */
function createRunAddRateLimiter(maxPerWindow: number) {
  const timestampsByRunId = new Map<string, number[]>();
  return {
    allow(runId: string): boolean {
      const now = Date.now();
      const cutoff = now - RATE_WINDOW_MS;
      const recent = (timestampsByRunId.get(runId) ?? []).filter(
        (timestamp) => timestamp > cutoff,
      );
      if (recent.length >= maxPerWindow) {
        timestampsByRunId.set(runId, recent);
        return false;
      }
      recent.push(now);
      timestampsByRunId.set(runId, recent);
      return true;
    },
  };
}

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
      const base = {
        principalId: scope.principalId,
        tenantId: scope.tenantId,
        query: input.query,
      };
      const withLimit =
        input.limit !== undefined ? { ...base, limit: input.limit } : base;
      const params =
        input.kinds !== undefined
          ? { ...withLimit, kinds: input.kinds }
          : withLimit;
      return memory.search(params);
    },
    async add(scope, input) {
      const base = {
        principalId: scope.principalId,
        tenantId: scope.tenantId,
        content: { title: input.title, text: input.text },
      };
      const params =
        input.kind !== undefined ? { ...base, kind: input.kind } : base;
      const result = await memory.add(params);
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
  const addRateLimiter = createRunAddRateLimiter(MAX_ADDS_PER_RUN_PER_MINUTE);

  app.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = await deps.authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage:
            "Missing or unrecognized sidecar bearer token / run address",
        }),
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
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: "Invalid JSON body",
        }),
        400,
      );
    }
    const parsed = SearchBody(body);
    if (parsed instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: parsed.summary,
        }),
        400,
      );
    }
    const searchInput = {
      query: parsed.query,
      limit: parsed.limit ?? DEFAULT_SEARCH_LIMIT,
    };
    const result = await deps.store.search(
      c.get("workflowRunScope"),
      parsed.kinds !== undefined
        ? { ...searchInput, kinds: parsed.kinds }
        : searchInput,
    );
    return c.json({ data: result });
  });

  app.post("/add", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: "Invalid JSON body",
        }),
        400,
      );
    }
    const parsed = AddBody(body);
    if (parsed instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: parsed.summary,
        }),
        400,
      );
    }
    if (parsed.text.length > MAX_ADD_TEXT_CHARS) {
      return c.json(
        makeErrorEnvelope({
          code: "text_too_large",
          userMessage:
            `text is ${parsed.text.length} characters, over the ` +
            `${MAX_ADD_TEXT_CHARS}-character limit — shorten it or split ` +
            "it into multiple memory entries and try again.",
        }),
        413,
      );
    }

    const scope = c.get("workflowRunScope");
    if (!addRateLimiter.allow(scope.runId)) {
      return c.json(
        makeErrorEnvelope({
          code: "rate_limited",
          userMessage:
            `too many memory writes for this run in the last minute ` +
            `(limit ${MAX_ADDS_PER_RUN_PER_MINUTE}/min) — wait a moment ` +
            "before adding more.",
        }),
        429,
      );
    }

    // Explicit pick, never a spread of `parsed`: arktype does not strip
    // unvalidated keys, so a caller-supplied `tenantId`/`principalId` in
    // the body must never ride through to the store — attribution comes
    // only from the authenticated `workflowRunScope` above.
    const addInput = { title: parsed.title, text: parsed.text };
    const added = await deps.store.add(
      scope,
      parsed.kind !== undefined ? { ...addInput, kind: parsed.kind } : addInput,
    );
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
 * `EMBED_BASE_URL` / `OLLAMA_BASE_URL`, see `apps/hub/src/memory-mount.ts`)
 * — same convention as `createUnavailableWorkflowArtifactRoutes`.
 */
export function createUnavailableWorkflowMemoryRoutes(): Hono<WorkflowMemoryEnv> {
  const app = new Hono<WorkflowMemoryEnv>();
  const unavailable = (c: {
    json: (body: unknown, status: 503) => Response | Promise<Response>;
  }) =>
    c.json(
      makeErrorEnvelope({
        code: "unavailable",
        userMessage: "Memory plane is not configured on this hub",
      }),
      503,
    );
  app.post("/search", unavailable);
  app.post("/add", unavailable);
  app.get("/list", unavailable);
  return app;
}
