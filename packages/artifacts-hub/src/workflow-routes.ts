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
 * calls. Both scope every read/write to the authenticated run's own
 * tenant + principal — a run can never see or write another tenant's
 * artifacts, and the child process itself never holds a database handle.
 */
import { type } from "arktype";
import {
  anonymousIdentity,
  createArtifact,
  listArtifacts,
  serializeArtifactListItem,
  type ArtifactDb,
  type SerializedArtifactListItem,
} from "@corbits/artifacts";
import { Hono } from "hono";

import type {
  ResolvedWorkflowRunScope,
  WorkflowRunAuthenticator,
} from "./workflow-auth";
import {
  createRunWriteRateLimiter,
  MAX_WORKFLOW_WRITE_TEXT_CHARS,
  MAX_WORKFLOW_WRITES_PER_RUN_PER_MINUTE,
} from "./workflow-write-limits";

const DEFAULT_RECENT_LIMIT = 10;
const MAX_RECENT_LIMIT = 50;

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
};

const CreateWorkflowArtifactBody = type({
  title: "string > 0",
  kind: "string > 0",
  content: "string > 0",
});

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_RECENT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RECENT_LIMIT;
  return Math.min(n, MAX_RECENT_LIMIT);
}

/** Production store over an artifacts engine db handle. */
export function createWorkflowArtifactDbStore(
  db: ArtifactDb,
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
  const createRateLimiter = createRunWriteRateLimiter(
    MAX_WORKFLOW_WRITES_PER_RUN_PER_MINUTE,
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

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: "bad_request", message: "Invalid JSON body" } },
        400,
      );
    }
    const parsed = CreateWorkflowArtifactBody(body);
    if (parsed instanceof type.errors) {
      return c.json(
        { error: { code: "bad_request", message: parsed.summary } },
        400,
      );
    }
    if (parsed.content.length > MAX_WORKFLOW_WRITE_TEXT_CHARS) {
      return c.json(
        {
          error: {
            code: "content_too_large",
            message:
              `content is ${parsed.content.length} characters, over the ` +
              `${MAX_WORKFLOW_WRITE_TEXT_CHARS}-character limit — shorten it ` +
              "or split it into multiple artifacts and try again.",
          },
        },
        413,
      );
    }

    const scope = c.get("workflowRunScope");
    if (!createRateLimiter.allow(scope.runId)) {
      return c.json(
        {
          error: {
            code: "rate_limited",
            message:
              `too many artifact writes for this run in the last minute ` +
              `(limit ${MAX_WORKFLOW_WRITES_PER_RUN_PER_MINUTE}/min) — wait a ` +
              "moment before creating more.",
          },
        },
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
      {
        error: {
          code: "unavailable",
          message: "Artifacts plane is not configured on this hub",
        },
      },
      503,
    );
  app.post("/", unavailable);
  app.get("/recent", unavailable);
  return app;
}
