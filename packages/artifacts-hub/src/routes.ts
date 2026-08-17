/**
 * Tenant-scoped Library HTTP surface over the mounted `@corbits/artifacts`
 * engine: list (newest-first, paginated, optional text search), get-by-id,
 * multipart upload, and per-kind-segment counts for the Library nav.
 *
 * Authz uses the existing `asset` resource family so Library grants keep
 * working without inventing a parallel vocabulary.
 *
 * The store is injected so tests can exercise happy/empty/cross-tenant
 * without a live Postgres.
 */
import {
  ARTIFACT_UPLOAD_POLICY,
  anonymousIdentity,
  createFileArtifact,
  getArtifact,
  listArtifacts,
  resolveDownload,
  serializeArtifact,
  serializeArtifactListItem,
  UnsupportedUploadTypeError,
  type ArtifactDb,
  type ContentStore,
  type SerializedArtifact,
  type SerializedArtifactListItem,
} from "@corbits/artifacts";
import {
  LIBRARY_KIND_SEGMENTS,
  artifactMatchesLibraryKindSegment,
  type LibraryKindSegment,
} from "@corbits/artifact-ui/kind-filter";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { Hono } from "hono";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_FILE_COUNT = 50;
const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
// Safety cap on the counts walk: 200 pages of MAX_LIMIT rows each is 20,000
// artifacts, far past any real tenant today. A tenant that legitimately
// exceeds it — or a store whose cursor stops advancing — gets an honest
// "can't count that" instead of a route that hangs or lies with a partial
// total.
const MAX_COUNT_PAGES = 200;

/** Thrown when the counts walk cannot finish honestly — capped out or the
 * store's cursor stopped advancing — rather than ever returning a partial
 * count as if it were the whole tenant. */
export class ArtifactCountsIncompleteError extends Error {}

export type ArtifactListPage = {
  readonly data: readonly SerializedArtifactListItem[];
  readonly nextCursor: string | null;
};

/** Per-kind-segment counts for the Library nav, plus the tenant total. */
export type ArtifactCounts = {
  readonly all: number;
} & { readonly [K in (typeof LIBRARY_KIND_SEGMENTS)[number]]: number };

export type ArtifactUploadInput = {
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
};

/** Outcome of resolving an artifact's sandboxed HTML preview. */
export type ArtifactPreviewResult =
  | { readonly status: "ok"; readonly html: string }
  | { readonly status: "not_found" }
  | { readonly status: "unsupported" };

/** Minimal port the routes need — production wraps the engine db. */
export type ArtifactRoutesStore = {
  list(
    tenantId: string,
    opts: { limit: number; cursor: string | null; query: string | null },
  ): Promise<ArtifactListPage>;
  get(tenantId: string, artifactId: string): Promise<SerializedArtifact | null>;
  upload(
    tenantId: string,
    principalId: string,
    files: readonly ArtifactUploadInput[],
  ): Promise<readonly SerializedArtifact[]>;
  preview(tenantId: string, artifactId: string): Promise<ArtifactPreviewResult>;
};

/** Bare MIME type, stripped of any `; charset=...` parameter. */
function baseMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

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

function parseQuery(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, 200);
}

/**
 * Walks every page of a tenant's artifacts (unfiltered, so the same row
 * never gets double-counted or missed at a page boundary) and buckets each
 * row by the Library kind nav's segment predicate. Real counts over the
 * full tenant list, not an estimate from one page.
 */
async function countArtifactsByKindSegment(
  store: Pick<ArtifactRoutesStore, "list">,
  tenantId: string,
): Promise<ArtifactCounts> {
  let all = 0;
  const bySegment: Record<LibraryKindSegment, number> = {
    document: 0,
    sheet: 0,
    pdf: 0,
    routine: 0,
  };

  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page = await store.list(tenantId, {
      limit: MAX_LIMIT,
      cursor,
      query: null,
    });
    pages += 1;
    for (const row of page.data) {
      all += 1;
      for (const segment of LIBRARY_KIND_SEGMENTS) {
        if (artifactMatchesLibraryKindSegment(row, segment)) {
          bySegment[segment] += 1;
        }
      }
    }
    if (page.nextCursor === null) break;
    if (page.nextCursor === cursor) {
      throw new ArtifactCountsIncompleteError(
        `Artifact list cursor for tenant ${tenantId} did not advance past page ${pages}`,
      );
    }
    if (pages >= MAX_COUNT_PAGES) {
      throw new ArtifactCountsIncompleteError(
        `Artifact list for tenant ${tenantId} exceeds ${MAX_COUNT_PAGES} pages — counts would be incomplete`,
      );
    }
    cursor = page.nextCursor;
  }

  return {
    all,
    document: bySegment.document,
    sheet: bySegment.sheet,
    pdf: bySegment.pdf,
    routine: bySegment.routine,
  };
}

/** Prefer the browser-declared type when the upload policy accepts it. */
function resolveUploadMime(file: { name: string; type: string }): string {
  if (file.type !== "" && ARTIFACT_UPLOAD_POLICY.accepts(file.type)) {
    return file.type;
  }
  return file.type === "" ? "application/octet-stream" : file.type;
}

/** Production store over an artifacts engine db handle + content store. */
export function createArtifactDbStore(
  db: ArtifactDb,
  contentStore: ContentStore,
): ArtifactRoutesStore {
  return {
    async list(tenantId, opts) {
      const cursor = parseCursor(opts.cursor ?? undefined);
      const withCursor =
        cursor !== undefined
          ? { limit: opts.limit, cursor }
          : { limit: opts.limit };
      const filters =
        opts.query !== null ? { ...withCursor, query: opts.query } : withCursor;
      const result = await listArtifacts(
        db,
        anonymousIdentity,
        tenantId,
        filters,
      );
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
    async upload(tenantId, principalId, files) {
      const scope = { tenantId, principalId };
      const rows = await db.transaction(async (tx) => {
        const created = [];
        for (const file of files) {
          created.push(
            await createFileArtifact(tx, contentStore, {
              scope,
              ownerPrincipalId: principalId,
              filename: file.filename,
              mimeType: file.mimeType,
              policy: ARTIFACT_UPLOAD_POLICY,
              bytes: file.bytes,
              origin: "library-upload",
            }),
          );
        }
        return created;
      });
      return rows.map(serializeArtifact);
    },
    async preview(tenantId, artifactId) {
      const row = await getArtifact(db, artifactId);
      if (row === null || row.tenantId !== tenantId)
        return { status: "not_found" };
      const download = await resolveDownload(db, contentStore, row, false);
      if ("status" in download) {
        return {
          status: download.status === 404 ? "not_found" : "unsupported",
        };
      }
      if (baseMimeType(download.mimeType) !== "text/html") {
        return { status: "unsupported" };
      }
      const html =
        typeof download.body === "string"
          ? download.body
          : new TextDecoder().decode(download.body);
      return { status: "ok", html };
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
    const query = parseQuery(c.req.query("q") ?? undefined);
    const page = await deps.store.list(tenant.id, { limit, cursor, query });
    return c.json(page);
  });

  app.post("/upload", deps.requireGrant("asset:*", "write"), async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");

    let parsed: Record<string, unknown>;
    try {
      parsed = (await c.req.parseBody({ all: true })) as Record<
        string,
        unknown
      >;
    } catch {
      return c.json(
        { error: { code: "bad_request", message: "Invalid multipart body" } },
        400,
      );
    }

    const files: File[] = [];
    for (const value of Object.values(parsed)) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (entry instanceof File) files.push(entry);
      }
    }

    if (files.length === 0) {
      return c.json(
        {
          error: {
            code: "bad_request",
            message: "Expected at least one file field",
          },
        },
        400,
      );
    }
    if (files.length > MAX_UPLOAD_FILE_COUNT) {
      return c.json(
        {
          error: {
            code: "payload_too_large",
            message: `Too many files: ${files.length} exceeds the ${MAX_UPLOAD_FILE_COUNT} file limit`,
          },
        },
        413,
      );
    }

    let totalBytes = 0;
    const inputs: ArtifactUploadInput[] = [];
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        return c.json(
          {
            error: {
              code: "payload_too_large",
              message: `File "${file.name}" exceeds the ${MAX_UPLOAD_BYTES} byte limit`,
            },
          },
          413,
        );
      }
      totalBytes += file.size;
      if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
        return c.json(
          {
            error: {
              code: "payload_too_large",
              message: `Upload exceeds the ${MAX_UPLOAD_TOTAL_BYTES} byte aggregate limit`,
            },
          },
          413,
        );
      }
      inputs.push({
        filename: file.name,
        mimeType: resolveUploadMime(file),
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
    }

    try {
      const data = await deps.store.upload(tenant.id, principal.id, inputs);
      return c.json({ data }, 201);
    } catch (err) {
      if (err instanceof UnsupportedUploadTypeError) {
        return c.json(
          { error: { code: "unsupported_media_type", message: err.message } },
          415,
        );
      }
      throw err;
    }
  });

  app.get("/counts", deps.requireGrant("asset:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    try {
      const counts = await countArtifactsByKindSegment(deps.store, tenant.id);
      return c.json(counts);
    } catch (err) {
      if (err instanceof ArtifactCountsIncompleteError) {
        return c.json(
          { error: { code: "counts_unavailable", message: err.message } },
          503,
        );
      }
      throw err;
    }
  });

  // Sandboxed HTML preview: served with a locked-down CSP so a self-contained
  // page renders visually but can reach nothing on the hub's own origin.
  //  - `sandbox allow-scripts` (the header, mirrored by the iframe's own
  //    `sandbox` attribute): scripts may run, but the document sits in an
  //    opaque unique origin — no cookies, no storage, no same-origin fetches,
  //    no top-level navigation, no popups.
  //  - `default-src 'none'`: nothing loads unless a more specific directive
  //    below allows it — no network reach to the hub API or anywhere else.
  //  - `style-src 'unsafe-inline'`: inline `<style>`/`style=` renders, since a
  //    single-file page has no external stylesheet to fetch.
  //  - `img-src data:`: inline data-URL images render; no external image
  //    fetches.
  //  - `script-src 'unsafe-inline'`: inline `<script>` runs, matching the
  //    `sandbox allow-scripts` directive above; no external script fetches.
  // `X-Frame-Options` is deliberately never set — the page must stay
  // frameable by our own canvas iframe.
  app.get(
    "/:artifactId/preview",
    deps.requireGrant("asset:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const artifactId = c.req.param("artifactId");
      const result = await deps.store.preview(tenant.id, artifactId);
      if (result.status === "not_found") {
        return c.json(
          { error: { code: "not_found", message: "Artifact not found" } },
          404,
        );
      }
      if (result.status === "unsupported") {
        return c.json(
          {
            error: {
              code: "unsupported_media_type",
              message: "Artifact is not previewable HTML",
            },
          },
          415,
        );
      }
      return c.body(result.html, 200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'",
        "X-Content-Type-Options": "nosniff",
      });
    },
  );

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

/**
 * Honest degraded surface when the artifacts plane is not mounted: every
 * route answers 503 so the Library UI can distinguish "not configured"
 * from "empty bench" without inventing silent empty lists.
 */
export function createUnavailableArtifactRoutes(
  requireGrant: RequireGrant,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
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

  app.get("/", requireGrant("asset:*", "read"), unavailable);
  app.post("/upload", requireGrant("asset:*", "write"), unavailable);
  app.get("/counts", requireGrant("asset:*", "read"), unavailable);
  app.get("/:artifactId/preview", requireGrant("asset:*", "read"), unavailable);
  app.get("/:artifactId", requireGrant("asset:*", "read"), unavailable);
  return app;
}
