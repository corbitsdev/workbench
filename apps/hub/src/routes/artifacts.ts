import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { type } from "arktype";
import { getLogger } from "@intx/log";
import { schema as intxSchema } from "@intx/db";
import type { HubDb } from "../db";
import {
  artifact,
  artifactStatus,
  artifactVersion,
  upload,
} from "../db/schema";
import { requestBodySchema } from "../lib/openapi";
import { getRequestedUserContext } from "../lib/user-context";
import { artifactOrigins, type ArtifactSource } from "@workbench/shared";
import { MAX_UPLOAD_BYTES } from "./uploads";

const artifactOriginSet: ReadonlySet<string> = new Set(artifactOrigins);

// Trim before validating so a whitespace-only field is rejected (length is
// checked after trim) and the parsed value carries no leading/trailing space.
// One source of truth for the non-empty-after-trim rule.
const TrimmedNonEmpty = type("string")
  .pipe((raw: string) => raw.trim())
  .to("string > 0");

// Kinds this import path may mint. URL imports default to `link`, pasted text
// to `document`. An explicit kind must stay within this allowlist so an
// untrusted caller cannot stamp a file-shaped / downloadable kind (e.g.
// `csv-export`) onto a row whose content is actually a URL or text body.
const IMPORTABLE_ARTIFACT_KINDS = ["link", "document"] as const;
const ImportableArtifactKind = type.enumerated(...IMPORTABLE_ARTIFACT_KINDS);

// POST /artifacts request: a human importing collateral from an external
// source. `mode` selects the provenance origin — `url` links an external page
// (content is the URL), `text` stores a pasted document body.
const CreateArtifactRequest = type({
  mode: "'url' | 'text'",
  title: TrimmedNonEmpty,
  content: TrimmedNonEmpty,
  "kind?": ImportableArtifactKind,
});

const ErrorResponse = type({ error: "string" });

// File/folder upload (CL-2475). Binary is persisted to the `upload` table
// (BYTEA); each file yields one artifact row whose `source.upload.id` is the
// authoritative download reference (text `content` stays empty for file kinds)
// and whose `source.upload` records the file metadata. The per-file 10MB ceiling
// is shared with POST /uploads (MAX_UPLOAD_BYTES) — larger inputs are out of
// scope (object storage).

// A folder upload (`webkitdirectory`) can carry an unbounded number of files;
// without a cap the whole multipart body is buffered into memory and inserted
// inside one transaction, risking OOM and a long-held lock on the shared hub.
// Bound both the file count and the aggregate byte size; anything larger is
// rejected with a 413 before any binary is read into a Buffer.
const MAX_UPLOAD_FILE_COUNT = 50;
const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;

// Broadened beyond the xlsx-only POST /uploads allowlist to a sensible
// document/image/text set. Validate at the boundary so a disallowed payload is
// rejected with a clear message rather than persisted opaquely. Accept either
// the declared MIME or a known extension (browsers omit MIME for some types).
// SVG is deliberately excluded: it can carry inline <script> and would be a
// stored-XSS vector once served back on the app origin.
const ACCEPTED_UPLOAD_MIMES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/pdf",
  "application/json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// Extension → canonical MIME. Drives both the accept check and the effective
// MIME we persist when the browser omits `file.type` (common for some types),
// so kind mapping and content-type-based serving stay correct.
const EXTENSION_MIME: ReadonlyMap<string, string> = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".csv", "text/csv"],
  [".html", "text/html"],
  [".pdf", "application/pdf"],
  [".json", "application/json"],
  [
    ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [
    ".pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  [".doc", "application/msword"],
  [".xls", "application/vnd.ms-excel"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

function extensionMime(filename: string): string | undefined {
  const name = filename.toLowerCase();
  for (const [ext, mime] of EXTENSION_MIME) {
    if (name.endsWith(ext)) return mime;
  }
  return undefined;
}

// The MIME we trust for kind mapping and storage: the declared type when it is
// in the allowlist, otherwise the extension-derived type. Empty when neither
// resolves (the upload is then rejected by `isAcceptedArtifactUpload`).
function effectiveUploadMime(file: File): string {
  if (ACCEPTED_UPLOAD_MIMES.has(file.type)) return file.type;
  return extensionMime(file.name) ?? "";
}

function isAcceptedArtifactUpload(file: File): boolean {
  return effectiveUploadMime(file).length > 0;
}

function uploadArtifactKind(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "image";
  return "file";
}

function uploadDownloadFilename(filename: string): string {
  const cleaned = filename.replace(/[\r\n"\\]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "download";
}

// Pull the upload reference (download key) out of an artifact's opaque jsonb
// `source` bag. Present on file/image artifacts created via POST /artifacts/upload.
function uploadIdFromSource(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const uploadField = (raw as Record<string, unknown>).upload;
  if (typeof uploadField !== "object" || uploadField === null) return null;
  const id = (uploadField as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

const log = getLogger(["api", "artifacts"]);

// Kinds whose content is a downloadable file (served by GET /artifacts/:id/download).
// Mirrors the pre-M6 DOWNLOADABLE_ARTIFACT_KINDS; the SEO-enrichment CSV export is
// the only file-shaped artifact today.
const DOWNLOADABLE_ARTIFACT_KINDS: ReadonlySet<string> = new Set([
  "csv-export",
]);

type ArtifactRow = typeof artifact.$inferSelect;

// Provenance is required on every artifact created on or after CL-2432, but
// legacy rows persisted before then have a null `source`. Normalize those to an
// explicit `unknown` origin so the gallery can always render a "generated by"
// badge instead of silently dropping it.
function normalizeSource(raw: Record<string, unknown> | null): ArtifactSource {
  if (raw === null) return { origin: "unknown" };
  if (typeof raw.origin === "string" && artifactOriginSet.has(raw.origin)) {
    return raw as ArtifactSource;
  }
  return { ...raw, origin: "unknown" };
}

// Serialize an artifact row to the `Artifact` shape the web client parses
// (@workbench/shared). Timestamps are ISO strings; nullable columns default to
// null so the boundary schema validates.
function serializeArtifact(a: ArtifactRow) {
  return {
    id: a.id,
    parentId: a.parentId ?? null,
    kind: a.kind,
    title: a.title,
    content: a.content,
    source: normalizeSource(a.source ?? null),
    status: a.status,
    version: a.version,
    ownerPrincipalId: a.ownerPrincipalId ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

function csvDownloadFilename(title: string): string {
  const cleaned = title
    .replace(/[\r\n"\\]/g, "")
    .replace(/\.csv$/i, "")
    .trim();
  return `${cleaned.length > 0 ? cleaned : "export"}.csv`;
}

type OwnerNameRow = {
  ownerPrincipalId: string | null;
  ownerName: string | null;
};

async function attachOwnerNames(
  db: HubDb,
  tenantId: string,
  rows: OwnerNameRow[],
): Promise<void> {
  const ownerIds = [
    ...new Set(
      rows
        .map((r) => r.ownerPrincipalId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (ownerIds.length === 0) return;

  const ownerPrincipals = await db
    .select({
      id: intxSchema.principal.id,
      refId: intxSchema.principal.refId,
    })
    .from(intxSchema.principal)
    .where(
      and(
        eq(intxSchema.principal.tenantId, tenantId),
        inArray(intxSchema.principal.id, ownerIds),
      ),
    );
  const refIds = [...new Set(ownerPrincipals.map((p) => p.refId))];
  const users =
    refIds.length > 0
      ? await db
          .select({ id: intxSchema.user.id, name: intxSchema.user.name })
          .from(intxSchema.user)
          .where(inArray(intxSchema.user.id, refIds))
      : [];
  const nameByRefId = new Map(users.map((u) => [u.id, u.name]));
  const nameByPrincipalId = new Map(
    ownerPrincipals.map((p) => [p.id, nameByRefId.get(p.refId) ?? null]),
  );
  for (const r of rows) {
    if (r.ownerPrincipalId !== null) {
      r.ownerName = nameByPrincipalId.get(r.ownerPrincipalId) ?? null;
    }
  }
}

/**
 * Artifacts HTTP routes, restoring the surface the M6 cutover (#296) removed when
 * it deleted the old collateral/workflow router. The web `ArtifactGallery` GETs
 * `/artifacts` and `ArtifactBody` links to `/artifacts/:id/download`.
 *
 * Artifacts are tenant-scoped: every artifact (agent-written or workflow-written)
 * carries `tenantId`, so listing by the caller's resolved tenant returns the full
 * workbench set. `sessionName`/`sessionStatus` are left null — the pre-M6 workflow
 * display enrichment depended on the deleted workflow registry and is not part of
 * restoring the gallery.
 */
export function createArtifactsRouter(
  db: HubDb,
): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();

  // List the caller's tenant artifacts for the gallery, newest-first by default.
  router.get("/artifacts", async (c) => {
    const userId = c.get("userId");

    const requestedTenantId = c.req.query("tenantId");
    const searchQuery = (c.req.query("query")?.trim() ?? "")
      .slice(0, 200)
      .replace(/[%_\\]/g, "\\$&");
    const sortParam = c.req.query("sort");
    const kindParam = c.req.query("kind");
    const statusParam = c.req.query("status");
    const ownerPrincipalIdParam = c.req.query("ownerPrincipalId");
    const creatorKindParam = c.req.query("creatorKind");
    const createdAfterParam = c.req.query("createdAfter");
    const createdBeforeParam = c.req.query("createdBefore");
    const cursorParam = c.req.query("cursor");
    const limitParam = c.req.query("limit");

    let createdAfter: Date | undefined;
    if (createdAfterParam !== undefined) {
      createdAfter = new Date(createdAfterParam);
      if (Number.isNaN(createdAfter.getTime())) {
        return c.json({ error: "Invalid createdAfter filter" }, 400);
      }
    }
    // The gallery sends a date-only `yyyy-mm-dd` upper bound, which `new Date`
    // parses to UTC midnight. A naive `<= midnight` would drop every row created
    // later that same day (From=To=today then shows nothing). Treat a date-only
    // bound as inclusive end-of-day; a full timestamp is honored as given.
    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    let createdBefore: Date | undefined;
    if (createdBeforeParam !== undefined) {
      createdBefore = new Date(createdBeforeParam);
      if (Number.isNaN(createdBefore.getTime())) {
        return c.json({ error: "Invalid createdBefore filter" }, 400);
      }
      if (DATE_ONLY.test(createdBeforeParam)) {
        createdBefore.setUTCHours(23, 59, 59, 999);
      }
    }

    type ArtifactStatusValue = (typeof artifactStatus)[number];
    const isArtifactStatus = (value: string): value is ArtifactStatusValue =>
      (artifactStatus as readonly string[]).includes(value);

    let statusFilter: ArtifactStatusValue | undefined;
    if (statusParam !== undefined) {
      if (!isArtifactStatus(statusParam)) {
        return c.json({ error: "Invalid status filter" }, 400);
      }
      statusFilter = statusParam;
    }

    const creatorKindValues = ["user", "agent"] as const;
    type CreatorKindValue = (typeof creatorKindValues)[number];
    const isCreatorKind = (value: string): value is CreatorKindValue =>
      (creatorKindValues as readonly string[]).includes(value);

    let creatorKindFilter: CreatorKindValue | undefined;
    if (creatorKindParam !== undefined) {
      if (!isCreatorKind(creatorKindParam)) {
        return c.json({ error: "Invalid creatorKind filter" }, 400);
      }
      creatorKindFilter = creatorKindParam;
    }

    const pageLimit = Math.min(
      Math.max(1, Number(limitParam ?? 20) || 20),
      100,
    );

    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      requestedTenantId,
    );
    if (forbidden) {
      log.warn("User requested artifacts for inaccessible tenant", {
        userId,
        requestedTenantId,
      });
      return c.json({ error: "Tenant not accessible" }, 403);
    }
    if (!userContext) {
      return c.json({ artifacts: [], nextCursor: null });
    }

    const tenantWhere = eq(artifact.tenantId, userContext.tenantId);
    const searchWhere = searchQuery
      ? or(
          ilike(artifact.title, `%${searchQuery}%`),
          ilike(artifact.content, `%${searchQuery}%`),
        )
      : undefined;
    // Hide rejected by default; an explicit status filter overrides that.
    const hideRejectedWhere =
      statusFilter === undefined ? ne(artifact.status, "rejected") : undefined;
    const statusWhere = statusFilter
      ? eq(artifact.status, statusFilter)
      : undefined;
    const kindWhere = kindParam ? eq(artifact.kind, kindParam) : undefined;
    const ownerWhere = ownerPrincipalIdParam
      ? eq(artifact.ownerPrincipalId, ownerPrincipalIdParam)
      : undefined;

    // Creator-kind (agent vs human) is a facet on the owner principal, not a
    // column on `artifact`, so resolve the matching principal ids up front
    // and fold them into the artifact query as an ownerPrincipalId membership
    // check. No matches means the filter must exclude everything, not fall
    // through to unfiltered.
    let creatorKindWhere: ReturnType<typeof sql> | undefined;
    if (creatorKindFilter) {
      const matchingPrincipals = await db
        .select({ id: intxSchema.principal.id })
        .from(intxSchema.principal)
        .where(
          and(
            eq(intxSchema.principal.tenantId, userContext.tenantId),
            eq(intxSchema.principal.kind, creatorKindFilter),
          ),
        );
      const matchingIds = matchingPrincipals.map((p) => p.id);
      creatorKindWhere =
        matchingIds.length > 0
          ? inArray(artifact.ownerPrincipalId, matchingIds)
          : sql`false`;
    }
    const createdAfterWhere = createdAfter
      ? gte(artifact.createdAt, createdAfter)
      : undefined;
    const createdBeforeWhere = createdBefore
      ? lte(artifact.createdAt, createdBefore)
      : undefined;

    let cursorWhere: ReturnType<typeof or> | undefined;
    if (cursorParam !== undefined) {
      const separatorIndex = cursorParam.lastIndexOf("__");
      const cursorDate = new Date(cursorParam.slice(0, separatorIndex));
      const cursorId = cursorParam.slice(separatorIndex + 2);
      if (
        separatorIndex === -1 ||
        Number.isNaN(cursorDate.getTime()) ||
        cursorId.length === 0
      ) {
        return c.json({ error: "Invalid cursor" }, 400);
      }
      cursorWhere =
        sortParam === "oldest"
          ? or(
              gt(artifact.updatedAt, cursorDate),
              and(
                eq(artifact.updatedAt, cursorDate),
                gt(artifact.id, cursorId),
              ),
            )
          : or(
              lt(artifact.updatedAt, cursorDate),
              and(
                eq(artifact.updatedAt, cursorDate),
                lt(artifact.id, cursorId),
              ),
            );
    }

    const whereConditions = [
      tenantWhere,
      hideRejectedWhere,
      statusWhere,
      kindWhere,
      ownerWhere,
      creatorKindWhere,
      createdAfterWhere,
      createdBeforeWhere,
      searchWhere,
      cursorWhere,
    ].filter((cond): cond is NonNullable<typeof cond> => cond != null);

    const orderBy =
      sortParam === "oldest"
        ? [asc(artifact.updatedAt), asc(artifact.id)]
        : [desc(artifact.updatedAt), desc(artifact.id)];

    const fetched = await db.query.artifact.findMany({
      where: and(...whereConditions),
      orderBy,
      limit: pageLimit + 1,
    });

    let nextCursor: string | null = null;
    let page = fetched;
    if (fetched.length > pageLimit) {
      page = fetched.slice(0, pageLimit);
      const last = page[page.length - 1];
      if (last) nextCursor = `${last.updatedAt.toISOString()}__${last.id}`;
    }

    const rows = page.map((a) => ({
      ...serializeArtifact(a),
      sessionName: null,
      sessionStatus: null,
      ownerName: null as string | null,
    }));

    await attachOwnerNames(db, userContext.tenantId, rows);

    return c.json({ artifacts: rows, nextCursor });
  });

  // Single artifact for deep links (`/artifacts/:id`) — not limited to the first
  // gallery list page.
  router.get("/artifacts/:id", async (c) => {
    const id = c.req.param("id");
    const userId = c.get("userId");
    const requestedTenantId = c.req.query("tenantId");

    const art = await db.query.artifact.findFirst({
      where: eq(artifact.id, id),
    });
    if (!art) return c.json({ error: "Artifact not found" }, 404);

    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      requestedTenantId ?? art.tenantId,
    );
    if (forbidden) {
      return c.json({ error: "Tenant not accessible" }, 403);
    }
    if (!userContext || art.tenantId !== userContext.tenantId) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const row = {
      ...serializeArtifact(art),
      sessionName: null,
      sessionStatus: null,
      ownerName: null as string | null,
    };
    await attachOwnerNames(db, userContext.tenantId, [row]);

    return c.json({ artifact: row });
  });

  // Create an artifact from an external source (link a URL or paste text).
  // Provenance is required (CL-2432): URL imports record an `imported` origin,
  // pasted text a `manual` origin. File/folder upload + batch are a follow-up.
  router.post(
    "/artifacts",
    describeRoute({
      tags: ["artifacts"],
      summary:
        "Import an artifact from an external source (link a URL or paste text)",
      parameters: [
        {
          name: "tenantId",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: requestBodySchema(CreateArtifactRequest),
          },
        },
      },
      responses: {
        201: {
          description: "Artifact created",
          content: {
            "application/json": {
              schema: resolver(type({ artifact: "unknown" })),
            },
          },
        },
        400: { description: "Invalid request body" },
        403: { description: "Tenant not accessible" },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const requestedTenantId = c.req.query("tenantId");

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      const parsed = CreateArtifactRequest(body);
      if (parsed instanceof type.errors) {
        return c.json({ error: parsed.summary }, 400);
      }

      const title = parsed.title;
      const content = parsed.content;

      if (parsed.mode === "url") {
        let url: URL;
        try {
          url = new URL(content);
        } catch {
          return c.json({ error: "content must be a valid URL" }, 400);
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          return c.json({ error: "URL must be http or https" }, 400);
        }
      }

      const { context: userContext, forbidden } = await getRequestedUserContext(
        db,
        userId,
        requestedTenantId,
      );
      if (forbidden) {
        return c.json({ error: "Tenant not accessible" }, 403);
      }
      if (!userContext) {
        return c.json({ error: "No accessible workbench" }, 403);
      }

      const origin = parsed.mode === "url" ? "imported" : "manual";
      const defaultKind: (typeof IMPORTABLE_ARTIFACT_KINDS)[number] =
        parsed.mode === "url" ? "link" : "document";
      const kind = parsed.kind ?? defaultKind;
      const source: Record<string, unknown> = { origin };
      if (parsed.mode === "url") {
        source.url = content;
      }

      const now = new Date();
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(artifact)
          .values({
            tenantId: userContext.tenantId,
            principalId: userContext.principalId,
            ownerPrincipalId: userContext.principalId,
            kind,
            title,
            content,
            source,
            status: "draft",
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        if (!row) throw new Error("Failed to create artifact");

        await tx.insert(artifactVersion).values({
          artifactId: row.id,
          version: 1,
          title,
          content,
          authorId: userContext.principalId,
          createdAt: now,
        });

        return row;
      });

      log.info("Created artifact from source", {
        artifactId: created.id,
        origin,
        tenantId: userContext.tenantId,
      });

      return c.json(
        {
          artifact: {
            ...serializeArtifact(created),
            sessionName: null,
            sessionStatus: null,
            ownerName: null,
          },
        },
        201,
      );
    },
  );

  // Import one or more files as artifacts (CL-2475). Accepts multipart/form-data
  // with any number of File fields (a single file, a multi-select batch, or a
  // folder upload via `webkitdirectory`). Each file is stored once in the
  // `upload` table and produces one artifact row with an `imported` origin.
  router.post(
    "/artifacts/upload",
    describeRoute({
      tags: ["Artifacts"],
      summary: "Import files as artifacts",
      description:
        "Accepts multipart/form-data with one or more File fields. Each file is persisted to the upload table (BYTEA) and becomes an artifact with an `imported` origin; the artifact content holds the upload id. Returns the created set in one response.",
      requestBody: {
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: {
                files: {
                  type: "array",
                  items: { type: "string", format: "binary" },
                },
                generatedBy: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        201: { description: "Artifacts created" },
        400: {
          description: "No files supplied",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "No accessible workbench",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        413: {
          description: "A file exceeds the size limit",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        415: {
          description: "A file has an unsupported type",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const requestedTenantId = c.req.query("tenantId");

      const { context: userContext, forbidden } = await getRequestedUserContext(
        db,
        userId,
        requestedTenantId,
      );
      if (forbidden) {
        return c.json({ error: "Tenant not accessible" }, 403);
      }
      if (!userContext) {
        return c.json({ error: "No accessible workbench" }, 403);
      }

      const parsedBody = await c.req.parseBody({ all: true });
      const files: File[] = [];
      let generatedBy: string | undefined;
      for (const value of Object.values(parsedBody)) {
        if (Array.isArray(value)) {
          for (const entry of value) {
            if (entry instanceof File) files.push(entry);
          }
        } else if (value instanceof File) {
          files.push(value);
        } else if (typeof value === "string" && generatedBy === undefined) {
          const trimmed = value.trim();
          if (trimmed.length > 0) generatedBy = trimmed;
        }
      }

      if (files.length === 0) {
        return c.json({ error: "Expected at least one file field" }, 400);
      }

      if (files.length > MAX_UPLOAD_FILE_COUNT) {
        return c.json(
          {
            error: `Too many files: ${files.length} exceeds the ${MAX_UPLOAD_FILE_COUNT} file limit`,
          },
          413,
        );
      }

      let totalBytes = 0;
      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) {
          return c.json(
            {
              error: `File "${file.name}" exceeds the ${MAX_UPLOAD_BYTES} byte limit`,
            },
            413,
          );
        }
        totalBytes += file.size;
        if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
          return c.json(
            {
              error: `Upload exceeds the ${MAX_UPLOAD_TOTAL_BYTES} byte aggregate limit`,
            },
            413,
          );
        }
        if (!isAcceptedArtifactUpload(file)) {
          return c.json(
            { error: `File "${file.name}" has an unsupported type` },
            415,
          );
        }
      }

      const now = new Date();
      const created = await db.transaction(async (tx) => {
        const rows: ArtifactRow[] = [];
        for (const file of files) {
          const mimeType = effectiveUploadMime(file);
          const buffer = Buffer.from(await file.arrayBuffer());
          const [uploadRow] = await tx
            .insert(upload)
            .values({
              tenantId: userContext.tenantId,
              principalId: userContext.principalId,
              filename: file.name,
              mimeType,
              content: buffer,
              size: file.size,
            })
            .returning();
          if (!uploadRow) throw new Error("Failed to store upload");

          const source: Record<string, unknown> = {
            origin: "imported",
            upload: {
              id: uploadRow.id,
              filename: file.name,
              mimeType,
              size: file.size,
            },
          };
          if (generatedBy !== undefined) source.generatedBy = generatedBy;

          const [artifactRow] = await tx
            .insert(artifact)
            .values({
              tenantId: userContext.tenantId,
              principalId: userContext.principalId,
              ownerPrincipalId: userContext.principalId,
              kind: uploadArtifactKind(mimeType),
              title: file.name,
              content: "",
              source,
              status: "draft",
              version: 1,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          if (!artifactRow) throw new Error("Failed to create artifact");

          await tx.insert(artifactVersion).values({
            artifactId: artifactRow.id,
            version: 1,
            title: file.name,
            content: "",
            authorId: userContext.principalId,
            createdAt: now,
          });

          rows.push(artifactRow);
        }
        return rows;
      });

      log.info("Created artifacts from upload", {
        count: created.length,
        tenantId: userContext.tenantId,
      });

      return c.json(
        {
          artifacts: created.map((a) => ({
            ...serializeArtifact(a),
            sessionName: null,
            sessionStatus: null,
            ownerName: null,
          })),
        },
        201,
      );
    },
  );

  // Download a file-shaped artifact's content (CSV export). Tenant-scoped.
  router.get("/artifacts/:id/download", async (c) => {
    const id = c.req.param("id");
    const userId = c.get("userId");

    const art = await db.query.artifact.findFirst({
      where: eq(artifact.id, id),
    });
    if (!art) return c.json({ error: "Artifact not found" }, 404);

    const { context: userContext, forbidden } = await getRequestedUserContext(
      db,
      userId,
      art.tenantId,
    );
    if (forbidden || !userContext || art.tenantId !== userContext.tenantId) {
      return c.json({ error: "Forbidden" }, 403);
    }

    // File/image artifacts (POST /artifacts/upload) carry their binary in the
    // `upload` table, referenced by `source.upload.id`. Stream those bytes back
    // with the stored content type. Always `attachment` so user-supplied bytes
    // never execute inline on the app origin.
    const uploadId = uploadIdFromSource(art.source);
    if (uploadId) {
      const uploadRow = await db.query.upload.findFirst({
        where: eq(upload.id, uploadId),
      });
      if (!uploadRow || uploadRow.tenantId !== userContext.tenantId) {
        return c.json({ error: "Upload not found" }, 404);
      }
      c.header(
        "Content-Type",
        uploadRow.mimeType.length > 0
          ? uploadRow.mimeType
          : "application/octet-stream",
      );
      c.header(
        "Content-Disposition",
        `attachment; filename="${uploadDownloadFilename(uploadRow.filename)}"`,
      );
      const bytes = Uint8Array.from(uploadRow.content);
      return c.body(bytes.buffer as ArrayBuffer);
    }

    if (!DOWNLOADABLE_ARTIFACT_KINDS.has(art.kind)) {
      return c.json(
        { error: `Artifact kind "${art.kind}" is not downloadable` },
        400,
      );
    }

    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header(
      "Content-Disposition",
      `attachment; filename="${csvDownloadFilename(art.title)}"`,
    );
    return c.body(art.content);
  });

  return router;
}
