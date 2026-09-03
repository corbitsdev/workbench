/**
 * The sanctioned path for a workflow run to persist and read Library
 * artifacts (CL-6000). Mounted OUTSIDE the tenant-session prefix
 * (`TENANT_PREFIX`) `createArtifactRoutes` lives under: a workflow-process
 * child has no browser session, so every request here authenticates via
 * `WorkflowRunAuthenticator` instead of `resolveTenant` + `requireGrant`.
 *
 * `POST /` is the write side `pain-point-collateral`'s and
 * `collateral-generation`'s finalize tools call once approved. `GET
 * /recent` is the read side `@corbits/artifact-tools`' `artifact_list_recent`
 * calls. `GET /:id` (CL-6499) lets a run read back one artifact's content —
 * the render step of a research/due-diligence workflow reading the Markdown
 * brief it just saved with `POST /`, for instance — and `POST /binary`
 * (CL-6499) is the write side that same render step needs to persist its
 * rendered PDF: the tenant Library's own `POST /upload` accepts arbitrary
 * bytes but is authenticated by browser tenant session, not a workflow
 * run's sidecar token, so this route gives the workflow surface an
 * equivalent binary path over the same `ContentStore` (`@corbits/artifacts`'
 * `InlineContentStore` in production). Every route here scopes every
 * read/write to the authenticated run's own tenant + principal — a run can
 * never see or write another tenant's artifacts, and the child process
 * itself never holds a database handle.
 */
import { type } from "arktype";
import { createExpiringMap } from "@corbits/collections";
import {
  ARTIFACT_UPLOAD_POLICY,
  anonymousIdentity,
  createArtifact,
  createFileArtifact,
  getArtifact,
  listArtifacts,
  MAX_UPLOAD_BYTES,
  serializeArtifact,
  serializeArtifactListItem,
  SKILL_DRAFT_KIND,
  UnsupportedUploadTypeError,
  type ArtifactDb,
  type ContentStore,
  type SerializedArtifact,
  type SerializedArtifactListItem,
} from "@corbits/artifacts";
import { Hono } from "hono";
import { makeErrorEnvelope } from "@corbits/error-sink";

import type {
  ResolvedWorkflowRunScope,
  WorkflowRunAuthenticator,
} from "./workflow-auth";

const DEFAULT_RECENT_LIMIT = 10;
const MAX_RECENT_LIMIT = 50;

// Mirrors `@corbits/memory-hub`'s `MAX_ADD_TEXT_CHARS`: 64k characters is
// generous for any honest artifact body while still catching a model
// that pastes an entire tool result or file verbatim instead of the
// artifact it was asked to persist.
const MAX_ARTIFACT_CONTENT_CHARS = 64_000;

// A finalized turn can legitimately persist a handful of artifacts in
// one burst; 30/minute per run comfortably covers that while still
// catching a runaway loop before it floods Library storage.
export const MAX_CREATES_PER_RUN_PER_MINUTE = 30;
export const RATE_WINDOW_MS = 60_000;

// Same per-file ceiling the tenant Library's own `POST /upload` enforces
// (`MAX_UPLOAD_BYTES`) — one number for "how big a file artifact may be"
// rather than a second cap that could drift from it. A rendered
// due-diligence brief is a handful of pages, well under it, while an
// agent loop that tried to write something huge in one call still hits
// a hard wall before this same route's rate limiter (below) even sees a
// repeated attempt.
export const MAX_WORKFLOW_BINARY_BYTES = MAX_UPLOAD_BYTES;

/**
 * In-process sliding-window rate limiter, closed over per
 * `createWorkflowArtifactRoutes` call — resets on hub restart, which is
 * fine: unlike a durable redelivery-dedup claim, a rate bound only
 * needs to hold within one process's uptime, never across it. Per-process
 * also means per-replica: N hub replicas give one run an effective
 * N × `MAX_CREATES_PER_RUN_PER_MINUTE` budget, since each replica counts
 * only what it personally handled — a known fail-open gap, not a
 * fail-closed one, so it under-limits rather than wrongly rejecting a
 * caller a sibling replica hasn't seen yet.
 *
 * The per-run entry lives in a `createExpiringMap` (CL-7243) rather than
 * a plain `Map`, so a run's entry is reclaimed once it goes idle instead
 * of staying resident for the rest of the hub process's uptime. The TTL
 * is exactly `RATE_WINDOW_MS`: every `allow()` call re-`set`s the entry,
 * refreshing its expiry, so an entry can only lapse after a full window
 * with no calls for that run — by which point every timestamp it held
 * has already aged out of the sliding window's own `cutoff` filter below.
 * A shorter TTL could evict an entry (and thus its still-in-window
 * timestamps) before the window's filter would have dropped them,
 * silently resetting a caller's quota early; this TTL can't.
 */
export function createRunCreateRateLimiter(
  maxPerWindow: number,
  now: () => number = Date.now,
) {
  const timestampsByRunId = createExpiringMap<string, number[]>({
    ttlMs: RATE_WINDOW_MS,
    now,
  });
  return {
    allow(runId: string): boolean {
      const at = now();
      const cutoff = at - RATE_WINDOW_MS;
      const recent = (timestampsByRunId.get(runId) ?? []).filter(
        (timestamp) => timestamp > cutoff,
      );
      if (recent.length >= maxPerWindow) {
        timestampsByRunId.set(runId, recent);
        return false;
      }
      recent.push(at);
      timestampsByRunId.set(runId, recent);
      return true;
    },
    /** Live entry count, for tests asserting the map stays bounded. */
    get trackedRunCount(): number {
      return timestampsByRunId.size;
    },
  };
}

export type WorkflowArtifactEnv = {
  Variables: { workflowRunScope: ResolvedWorkflowRunScope };
};

export type CreateWorkflowArtifactInput = {
  readonly title: string;
  readonly kind: string;
  readonly content: string;
};

export type CreatedWorkflowArtifact = {
  readonly id: string;
  readonly version: number;
};

export type CreateWorkflowBinaryArtifactInput = {
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
};

/** Minimal port the routes need — production wraps the artifacts engine db. */
export type WorkflowArtifactRoutesStore = {
  create(
    scope: ResolvedWorkflowRunScope,
    input: CreateWorkflowArtifactInput,
  ): Promise<CreatedWorkflowArtifact>;
  listRecent(
    scope: ResolvedWorkflowRunScope,
    limit: number,
  ): Promise<readonly SerializedArtifactListItem[]>;
  /**
   * Fetch one artifact's full content back. Scoped exactly like
   * `@corbits/artifacts-hub`'s tenant-session `ArtifactRoutesStore.get`:
   * fetch by id, then treat any id that does not belong to this run's own
   * tenant as not found — never a distinguishable "forbidden".
   */
  get(
    scope: ResolvedWorkflowRunScope,
    artifactId: string,
  ): Promise<SerializedArtifact | null>;
  createBinary(
    scope: ResolvedWorkflowRunScope,
    input: CreateWorkflowBinaryArtifactInput,
  ): Promise<CreatedWorkflowArtifact>;
};

const CreateWorkflowArtifactBody = type({
  title: "string > 0",
  kind: "string > 0",
  content: "string > 0",
});

const CreateWorkflowBinaryArtifactBody = type({
  filename: "string > 0",
  mimeType: "string > 0",
  contentBase64: "string > 0",
});

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_RECENT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RECENT_LIMIT;
  return Math.min(n, MAX_RECENT_LIMIT);
}

/**
 * Production store over an artifacts engine db handle. `contentStore` is
 * the same byte sink the tenant Library's `createArtifactDbStore` wraps
 * (`InlineContentStore` in production) — reused rather than a second
 * storage mechanism for the workflow surface's binary path.
 */
export function createWorkflowArtifactDbStore(
  db: ArtifactDb,
  contentStore: ContentStore,
): WorkflowArtifactRoutesStore {
  return {
    async create(scope, input) {
      const row = await db.transaction((tx) =>
        createArtifact(tx, {
          scope: { tenantId: scope.tenantId, principalId: scope.principalId },
          // Workflow-authored artifacts have no human owner-member by
          // default; a human only enters the picture as the approver
          // who let the finalize tool call through, not as an owner.
          ownerPrincipalId: null,
          kind: input.kind,
          title: input.title,
          content: input.content,
          source: { origin: "workflow", runId: scope.runId },
        }),
      );
      return { id: row.id, version: row.version };
    },
    async listRecent(scope, limit) {
      const result = await listArtifacts(
        db,
        anonymousIdentity,
        scope.tenantId,
        {
          limit,
        },
      );
      return result.rows.map(serializeArtifactListItem);
    },
    async get(scope, artifactId) {
      const row = await getArtifact(db, artifactId);
      // Fetch-then-check, exactly mirroring `createArtifactDbStore`'s own
      // `get` in `routes.ts`: an id from another tenant reads back
      // identically to an id that never existed, never a distinguishable
      // 403. Additionally excludes `skill-draft` rows — internal
      // skill-authoring scratch that every artifact surface treats as not
      // found (see `SKILL_DRAFT_KIND`'s doc comment upstream) — a check
      // `routes.ts`'s browser-session `get` is missing today.
      if (
        row === null ||
        row.tenantId !== scope.tenantId ||
        row.kind === SKILL_DRAFT_KIND
      ) {
        return null;
      }
      return serializeArtifact(row);
    },
    async createBinary(scope, input) {
      const artifactScope = {
        tenantId: scope.tenantId,
        principalId: scope.principalId,
      };
      const row = await db.transaction((tx) =>
        createFileArtifact(tx, contentStore, {
          scope: artifactScope,
          ownerPrincipalId: null,
          filename: input.filename,
          mimeType: input.mimeType,
          bytes: input.bytes,
          policy: ARTIFACT_UPLOAD_POLICY,
          origin: "workflow",
          generatedBy: scope.runId,
        }),
      );
      return { id: row.id, version: row.version };
    },
  };
}

export type CreateWorkflowArtifactRoutesDeps = {
  authenticator: WorkflowRunAuthenticator;
  store: WorkflowArtifactRoutesStore;
};

export function createWorkflowArtifactRoutes(
  deps: CreateWorkflowArtifactRoutesDeps,
): Hono<WorkflowArtifactEnv> {
  const app = new Hono<WorkflowArtifactEnv>();
  const createRateLimiter = createRunCreateRateLimiter(
    MAX_CREATES_PER_RUN_PER_MINUTE,
  );

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

  app.post("/", async (c) => {
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
    const parsed = CreateWorkflowArtifactBody(body);
    if (parsed instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: parsed.summary,
        }),
        400,
      );
    }
    if (parsed.content.length > MAX_ARTIFACT_CONTENT_CHARS) {
      return c.json(
        makeErrorEnvelope({
          code: "content_too_large",
          userMessage:
            `content is ${parsed.content.length} characters, over the ` +
            `${MAX_ARTIFACT_CONTENT_CHARS}-character limit — shorten it ` +
            "or split it into multiple artifacts and try again.",
        }),
        413,
      );
    }

    const scope = c.get("workflowRunScope");
    if (!createRateLimiter.allow(scope.runId)) {
      return c.json(
        makeErrorEnvelope({
          code: "rate_limited",
          userMessage:
            `too many artifact writes for this run in the last minute ` +
            `(limit ${MAX_CREATES_PER_RUN_PER_MINUTE}/min) — wait a ` +
            "moment before creating more.",
        }),
        429,
      );
    }

    const created = await deps.store.create(scope, parsed);
    return c.json({ data: created }, 201);
  });

  app.get("/recent", async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const data = await deps.store.listRecent(c.get("workflowRunScope"), limit);
    return c.json({ data });
  });

  app.post("/binary", async (c) => {
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
    const parsed = CreateWorkflowBinaryArtifactBody(body);
    if (parsed instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: parsed.summary,
        }),
        400,
      );
    }

    const bytes = Buffer.from(parsed.contentBase64, "base64");
    if (bytes.byteLength > MAX_WORKFLOW_BINARY_BYTES) {
      return c.json(
        makeErrorEnvelope({
          code: "content_too_large",
          userMessage:
            `content is ${bytes.byteLength} bytes, over the ` +
            `${MAX_WORKFLOW_BINARY_BYTES}-byte limit — shorten it or ` +
            "split it into multiple artifacts and try again.",
        }),
        413,
      );
    }

    const scope = c.get("workflowRunScope");
    if (!createRateLimiter.allow(scope.runId)) {
      return c.json(
        makeErrorEnvelope({
          code: "rate_limited",
          userMessage:
            `too many artifact writes for this run in the last minute ` +
            `(limit ${MAX_CREATES_PER_RUN_PER_MINUTE}/min) — wait a ` +
            "moment before creating more.",
        }),
        429,
      );
    }

    try {
      const created = await deps.store.createBinary(scope, {
        filename: parsed.filename,
        mimeType: parsed.mimeType,
        bytes: new Uint8Array(bytes),
      });
      return c.json({ data: created }, 201);
    } catch (err) {
      if (err instanceof UnsupportedUploadTypeError) {
        return c.json(
          makeErrorEnvelope({
            code: "unsupported_media_type",
            userMessage: err.message,
          }),
          415,
        );
      }
      throw err;
    }
  });

  app.get("/:id", async (c) => {
    const scope = c.get("workflowRunScope");
    const artifactId = c.req.param("id");
    const row = await deps.store.get(scope, artifactId);
    if (row === null) {
      return c.json(
        makeErrorEnvelope({
          code: "not_found",
          userMessage: "Artifact not found",
        }),
        404,
      );
    }
    return c.json({ data: row });
  });

  return app;
}

/**
 * Honest degraded surface when the artifacts plane is not mounted — same
 * convention as `createUnavailableArtifactRoutes`.
 */
export function createUnavailableWorkflowArtifactRoutes(): Hono<WorkflowArtifactEnv> {
  const app = new Hono<WorkflowArtifactEnv>();
  const unavailable = (c: {
    json: (body: unknown, status: 503) => Response | Promise<Response>;
  }) =>
    c.json(
      makeErrorEnvelope({
        code: "unavailable",
        userMessage: "Artifacts plane is not configured on this hub",
      }),
      503,
    );
  app.post("/", unavailable);
  app.get("/recent", unavailable);
  app.post("/binary", unavailable);
  app.get("/:id", unavailable);
  return app;
}
