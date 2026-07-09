import type { AgentTool } from "@intx/agent";
import type { DB } from "@intx/db";
import { schema as intxSchema } from "@intx/db";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  ARTIFACT_CREATE_DEFINITION,
  ARTIFACT_FIND_BY_TITLE_DEFINITION,
  ARTIFACT_LINK_FILE_DEFINITION,
  ARTIFACT_LINK_GAMMA_PRESENTATION_DEFINITION,
  ARTIFACT_LINK_PRESENTATION_DEFINITION,
  ARTIFACT_LIST_DEFINITION,
  ARTIFACT_READ_CHUNK_DEFINITION,
  ARTIFACT_READ_DEFINITION,
  ARTIFACT_WRITE_DEFINITION,
} from "@workbench/tools-artifact";
import {
  GammaPresentationContentSchema,
  parseWebSiteContentJson,
  serializeWebSiteContent,
  WEB_SITE_KIND,
  normalizeWebSitePath,
  summarizeWebSiteContent,
} from "@workbench/shared";
import { getLogger } from "@intx/log";
import { and, desc, eq, ne } from "drizzle-orm";
import {
  artifact,
  artifactStatus,
  artifactVersion,
  MAX_UPLOAD_BYTES,
  memberAgentInstance,
  upload,
} from "../db/schema";

export {
  ARTIFACT_CREATE_DEFINITION,
  ARTIFACT_FIND_BY_TITLE_DEFINITION,
  ARTIFACT_LINK_FILE_DEFINITION,
  ARTIFACT_LINK_GAMMA_PRESENTATION_DEFINITION,
  ARTIFACT_LINK_PRESENTATION_DEFINITION,
  ARTIFACT_LIST_DEFINITION,
  ARTIFACT_READ_CHUNK_DEFINITION,
  ARTIFACT_READ_DEFINITION,
  ARTIFACT_WRITE_DEFINITION,
};

type ArtifactStatus = (typeof artifactStatus)[number];

type FetchFn = typeof fetch;

type ArtifactToolContext = {
  db: DB["db"];
  tenantId: string;
  principalId: string;
  agentId: string;
  sessionId: string;
  // Injected HTTP client for pulling the Gamma export PDF; defaults to the
  // global fetch. Injected in tests to keep the pull deterministic.
  fetch?: FetchFn;
};

const log = getLogger(["lib", "artifact-tools"]);

type UploadPayload = {
  content: Buffer;
  filename: string;
  mimeType: string;
  size: number;
};

function pdfDownloadFilename(title: string): string {
  const cleaned = title
    .replace(/[\r\n"\\/]/g, "")
    .replace(/\.pdf$/i, "")
    .trim();
  return `${cleaned.length > 0 ? cleaned : "deck"}.pdf`;
}

// The export CDN can stall without ever returning a status; bound the download
// so a hung fetch cannot wedge the (otherwise interactive) tool call.
const GAMMA_PDF_FETCH_TIMEOUT_MS = 20_000;

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

// Pull the Gamma export PDF into a durable upload payload. The export URL is a
// short-lived Gamma download link (~1 week), so the bytes are ingested now
// rather than persisted as an expiring URL. The PDF is supplementary to the
// deck link: any failure (network, timeout, oversize, empty) degrades to no PDF
// rather than failing the whole persist.
async function fetchGammaPresentationPdf(
  context: ArtifactToolContext,
  pdfUrl: string,
  title: string,
  signal?: AbortSignal,
): Promise<UploadPayload | null> {
  // `pdfUrl` is agent-influenced on this tool, so require https before the hub
  // issues a server-side fetch — this closes the plaintext-internal-service /
  // metadata (http://169.254.169.254) SSRF vector. Residual blind SSRF to an
  // internal TLS host is out of scope: the real path passes Gamma's own trusted
  // exportUrl, and the bytes are stored, never returned to the caller. Revisit
  // if pdfUrl ever becomes genuinely free-form.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(pdfUrl);
  } catch {
    log.warn("Gamma export PDF url is not a valid URL; skipping PDF");
    return null;
  }
  if (parsedUrl.protocol !== "https:") {
    log.warn("Gamma export PDF url is not https; skipping PDF");
    return null;
  }

  const fetchFn = context.fetch ?? fetch;
  const timeout = AbortSignal.timeout(GAMMA_PDF_FETCH_TIMEOUT_MS);
  const abort =
    signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    // `redirect: "error"` so a 3xx to a plaintext internal host can't slip past
    // the https check above (Gamma's signed export URLs serve directly, no hop).
    const response = await fetchFn(pdfUrl, {
      signal: abort,
      redirect: "error",
    });
    if (!response.ok) {
      log.warn("Gamma export PDF fetch returned non-2xx; skipping PDF", {
        status: response.status,
      });
      return null;
    }
    const declaredLength = parseContentLength(
      response.headers.get("content-length"),
    );
    if (declaredLength !== null && declaredLength > MAX_UPLOAD_BYTES) {
      log.warn("Gamma export PDF exceeds the upload ceiling; skipping PDF", {
        size: declaredLength,
        limit: MAX_UPLOAD_BYTES,
      });
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0) {
      log.warn("Gamma export PDF was empty; skipping PDF");
      return null;
    }
    // A 200 can still carry an HTML error page; require the PDF magic bytes so
    // a non-PDF body is never stored and served as application/pdf.
    if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
      log.warn("Gamma export PDF body is not a PDF; skipping PDF");
      return null;
    }
    if (buffer.byteLength > MAX_UPLOAD_BYTES) {
      log.warn("Gamma export PDF exceeds the upload ceiling; skipping PDF", {
        size: buffer.byteLength,
        limit: MAX_UPLOAD_BYTES,
      });
      return null;
    }
    return {
      content: buffer,
      filename: pdfDownloadFilename(title),
      mimeType: "application/pdf",
      size: buffer.byteLength,
    };
  } catch (cause) {
    log.warn("Gamma export PDF fetch failed; skipping PDF", { cause });
    return null;
  }
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function optionalNonEmptyString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${key} must not be empty`);
  }
  return trimmed;
}

function optionalStatus(
  args: Record<string, unknown>,
): ArtifactStatus | undefined {
  const value = optionalString(args, "status");
  if (value === undefined) return undefined;
  if (!artifactStatus.includes(value as ArtifactStatus)) {
    throw new Error(`status must be one of: ${artifactStatus.join(", ")}`);
  }
  return value as ArtifactStatus;
}

function optionalVersion(args: Record<string, unknown>): number | undefined {
  const value = args.version;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("version must be a positive integer");
  }
  return value;
}

const DEFAULT_READ_LIMIT = 8000;

function optionalOffset(args: Record<string, unknown>): number | undefined {
  const value = args.offset;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("offset must be a non-negative integer");
  }
  return value;
}

function optionalLimit(args: Record<string, unknown>): number | undefined {
  const value = args.limit;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("limit must be a positive integer");
  }
  return value;
}

type ReadResult = {
  artifactId: string;
  title: string;
  kind: string;
  status: string;
  version: number;
  content: string;
  contentLength?: number;
  chunkStart?: number;
  chunkEnd?: number;
  continuation?: string;
};

// The runtime caps a tool result at ~10K characters and spills the rest to a
// tool-output:// URI the agent cannot read. A chunk is measured in raw
// characters, but the result is JSON-encoded before that cap applies, and
// escaping (newlines, quotes) can inflate it — so the encoded result, not the
// raw slice, must stay under this budget to avoid re-triggering the spill.
const SAFE_ENCODED_BUDGET = 9000;

function buildChunk(
  base: Omit<ReadResult, "content">,
  content: string,
  start: number,
  end: number,
  total: number,
): ReadResult {
  const result: ReadResult = {
    ...base,
    content: content.slice(start, end),
    contentLength: total,
    chunkStart: start,
    chunkEnd: end,
  };
  if (end < total) {
    result.continuation = `Showing characters ${start}–${end} of ${total}. Call artifact_read_chunk again with offset=${end} (same artifactId) to read the next chunk, and keep going until there is no continuation field.`;
  }
  return result;
}

function windowContent(
  base: Omit<ReadResult, "content">,
  content: string,
  offset: number | undefined,
  limit: number | undefined,
): ReadResult {
  const total = content.length;
  const hasWindow = offset !== undefined || limit !== undefined;
  if (!hasWindow && total <= DEFAULT_READ_LIMIT) {
    const whole: ReadResult = { ...base, content };
    if (jsonResult(whole).length <= SAFE_ENCODED_BUDGET) {
      return whole;
    }
  }

  const start = Math.min(offset ?? 0, total);
  const size = limit ?? DEFAULT_READ_LIMIT;
  let end = Math.min(start + size, total);
  let result = buildChunk(base, content, start, end, total);
  while (end > start + 1 && jsonResult(result).length > SAFE_ENCODED_BUDGET) {
    const ratio = SAFE_ENCODED_BUDGET / jsonResult(result).length;
    const shrunk = start + Math.max(1, Math.floor((end - start) * ratio));
    end = shrunk >= end ? end - 1 : shrunk;
    result = buildChunk(base, content, start, end, total);
  }
  return result;
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function normalizeArtifactContentForKind(
  kind: string,
  content: string,
): string {
  if (kind === WEB_SITE_KIND) {
    return serializeWebSiteContent(parseWebSiteContentJson(content));
  }
  return content;
}

function assertArtifactContentForKind(kind: string, content: string): void {
  if (kind === WEB_SITE_KIND) {
    parseWebSiteContentJson(content);
  }
}

function assertSessionContext(context: ArtifactToolContext): void {
  if (typeof context.sessionId !== "string" || context.sessionId.length === 0) {
    throw new Error("session context is required");
  }
}

function createLinkFileHandler(context: ArtifactToolContext): AgentTool {
  return {
    kind: "string",
    definition: ARTIFACT_LINK_FILE_DEFINITION,
    handler: async (args) => {
      const title = requiredString(args, "title");
      const kind = requiredString(args, "kind");
      const path = requiredString(args, "path");
      const preview =
        typeof args.preview === "string" ? args.preview.trim() : "";
      const content = preview || `Linked file: ${path}`;
      const source = {
        origin: "agent",
        type: "posix_file",
        path,
        agentId: context.agentId,
        sessionId: context.sessionId,
      };
      assertSessionContext(context);
      const now = new Date();
      const ownerMemberId = await resolveOwnerMemberPrincipalId(
        context.db,
        context,
      );

      const row = await context.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(artifact)
          .values({
            tenantId: context.tenantId,
            principalId: context.principalId,
            ownerPrincipalId: ownerMemberId ?? null,
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

        if (!created) throw new Error("Failed to create artifact");

        await tx.insert(artifactVersion).values({
          artifactId: created.id,
          version: 1,
          title,
          content,
          authorId: context.principalId,
          createdAt: now,
        });

        return created;
      });

      return jsonResult({ artifactId: row.id, title, kind, path });
    },
  };
}

function createCreateHandler(context: ArtifactToolContext): AgentTool {
  return {
    kind: "string",
    definition: ARTIFACT_CREATE_DEFINITION,
    handler: async (args) => {
      const title = requiredString(args, "title");
      const kind = requiredString(args, "kind");
      if (kind === "skill-draft") {
        throw new Error(
          "skill-draft artifacts must be created with the skill_draft tool",
        );
      }
      const content = normalizeArtifactContentForKind(
        kind,
        requiredString(args, "content"),
      );
      assertArtifactContentForKind(kind, content);
      const source = {
        origin: "agent",
        type: "inline",
        agentId: context.agentId,
        sessionId: context.sessionId,
      };
      // No assertSessionContext: artifact_create does not persist the session as
      // a data dependency — it is only a vestigial gate. A deterministic workflow
      // tool step has no chat session, so requiring one blocked every
      // workflow-generated artifact. Standalone artifacts are valid
      // (tenant-scoped, visible in the gallery).
      const now = new Date();
      const ownerMemberId = await resolveOwnerMemberPrincipalId(
        context.db,
        context,
      );

      const row = await context.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(artifact)
          .values({
            tenantId: context.tenantId,
            principalId: context.principalId,
            ownerPrincipalId: ownerMemberId ?? null,
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

        if (!created) throw new Error("Failed to create artifact");

        await tx.insert(artifactVersion).values({
          artifactId: created.id,
          version: 1,
          title,
          content,
          authorId: context.principalId,
          createdAt: now,
        });

        return created;
      });

      return jsonResult({ artifactId: row.id, title, kind, version: 1 });
    },
  };
}

/**
 * Resolve the human member principal id (`memberPrincipalId`) that owns
 * the agent identified by the tool context. Returns null when the agent
 * has no owning member (e.g. a system agent).
 *
 * Walks: context.principalId -> agent_instance -> member_agent_instance
 */
export async function resolveOwnerMemberPrincipalId(
  db: DB["db"],
  context: { tenantId: string; principalId: string },
): Promise<string | null> {
  const instanceRows = await db
    .select({ id: intxSchema.agentInstance.id })
    .from(intxSchema.agentInstance)
    .where(
      and(
        eq(intxSchema.agentInstance.tenantId, context.tenantId),
        eq(intxSchema.agentInstance.principalId, context.principalId),
      ),
    )
    .limit(1);
  const instanceId = instanceRows[0]?.id;
  if (!instanceId) return null;

  const ownerRows = await db
    .select({ memberPrincipalId: memberAgentInstance.memberPrincipalId })
    .from(memberAgentInstance)
    .where(
      and(
        eq(memberAgentInstance.tenantId, context.tenantId),
        eq(memberAgentInstance.instanceId, instanceId),
      ),
    )
    .limit(1);
  return ownerRows[0]?.memberPrincipalId ?? null;
}

// Verify the agent's owning user is an active member of targetTenantId.
// Walks: agent instance -> member_agent_instance -> owner principal -> refId ->
// principal in target tenant. Fails closed (returns false) at any missing step.
async function ownerIsMemberOfTenant(
  db: DB["db"],
  context: { tenantId: string; principalId: string },
  targetTenantId: string,
): Promise<boolean> {
  const ownerPrincipalId = await resolveOwnerMemberPrincipalId(db, context);
  if (!ownerPrincipalId) return false;

  const refIdRows = await db
    .select({ refId: intxSchema.principal.refId })
    .from(intxSchema.principal)
    .where(eq(intxSchema.principal.id, ownerPrincipalId))
    .limit(1);
  const userRefId = refIdRows[0]?.refId;
  if (!userRefId) return false;

  const membershipRows = await db
    .select({ id: intxSchema.principal.id })
    .from(intxSchema.principal)
    .where(
      and(
        eq(intxSchema.principal.tenantId, targetTenantId),
        eq(intxSchema.principal.kind, "user"),
        eq(intxSchema.principal.refId, userRefId),
        eq(intxSchema.principal.status, "active"),
      ),
    )
    .limit(1);
  return membershipRows.length > 0;
}

async function resolveArtifactContent(
  context: ArtifactToolContext,
  args: Record<string, unknown>,
): Promise<{ base: Omit<ReadResult, "content">; content: string }> {
  const artifactId = requiredString(args, "artifactId");
  const version = optionalVersion(args);
  const tenantId = optionalString(args, "tenantId") ?? context.tenantId;

  if (tenantId !== context.tenantId) {
    const allowed = await ownerIsMemberOfTenant(context.db, context, tenantId);
    if (!allowed) throw new Error(`Artifact not found: ${artifactId}`);
  }

  const [row] = await context.db
    .select()
    .from(artifact)
    .where(and(eq(artifact.id, artifactId), eq(artifact.tenantId, tenantId)))
    .limit(1);

  if (!row) throw new Error(`Artifact not found: ${artifactId}`);

  if (version === undefined) {
    return {
      base: {
        artifactId: row.id,
        title: row.title,
        kind: row.kind,
        status: row.status,
        version: row.version,
      },
      content: row.content,
    };
  }

  const [versionRow] = await context.db
    .select()
    .from(artifactVersion)
    .where(
      and(
        eq(artifactVersion.artifactId, artifactId),
        eq(artifactVersion.version, version),
      ),
    )
    .limit(1);

  if (!versionRow) {
    throw new Error(`Version ${version} not found for artifact ${artifactId}`);
  }

  return {
    base: {
      artifactId: row.id,
      title: versionRow.title,
      kind: row.kind,
      status: row.status,
      version: versionRow.version,
    },
    content: versionRow.content,
  };
}

function createReadHandler(context: ArtifactToolContext): AgentTool {
  return {
    kind: "string",
    definition: ARTIFACT_READ_DEFINITION,
    handler: async (args) => {
      const filePath = optionalNonEmptyString(args, "path");
      const { base, content } = await resolveArtifactContent(context, args);
      // skill-draft is private authoring scratch; use skill_draft / library tools.
      if (base.kind === "skill-draft") {
        throw new Error(`Artifact not found: ${base.artifactId}`);
      }

      if (base.kind === WEB_SITE_KIND) {
        if (filePath !== undefined) {
          const site = parseWebSiteContentJson(content);
          const normalized = normalizeWebSitePath(filePath);
          const fileContent = site.files[normalized];
          if (fileContent === undefined) {
            throw new Error(
              `File not found in web_site artifact: ${normalized}`,
            );
          }
          const windowed = windowContent(
            base,
            fileContent,
            undefined,
            undefined,
          );
          return jsonResult({ ...windowed, path: normalized });
        }
        return jsonResult({
          ...base,
          summary: summarizeWebSiteContent(content),
        });
      }

      return jsonResult(windowContent(base, content, undefined, undefined));
    },
  };
}

function createReadChunkHandler(context: ArtifactToolContext): AgentTool {
  return {
    kind: "string",
    definition: ARTIFACT_READ_CHUNK_DEFINITION,
    handler: async (args) => {
      const offset = optionalOffset(args) ?? 0;
      const limit = optionalLimit(args) ?? DEFAULT_READ_LIMIT;
      const { base, content } = await resolveArtifactContent(context, args);
      if (base.kind === "skill-draft") {
        throw new Error(`Artifact not found: ${base.artifactId}`);
      }
      if (base.kind === WEB_SITE_KIND) {
        throw new Error(
          "artifact_read_chunk does not support web_site artifacts; use artifact_read for a summary or pass path to read one file",
        );
      }
      return jsonResult(windowContent(base, content, offset, limit));
    },
  };
}

function createWriteHandler(context: ArtifactToolContext): AgentTool {
  return {
    kind: "string",
    definition: ARTIFACT_WRITE_DEFINITION,
    handler: async (args) => {
      const artifactId = requiredString(args, "artifactId");
      const nextContent = optionalNonEmptyString(args, "content");
      const nextTitle = optionalNonEmptyString(args, "title");

      if (nextContent === undefined && nextTitle === undefined) {
        throw new Error("Provide content and/or title to revise the artifact");
      }

      const now = new Date();

      // Read, version-bump, and write inside one transaction with the artifact
      // row locked (FOR UPDATE), so concurrent writers serialize instead of both
      // computing the same next version (lost update / duplicate version row).
      return await context.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(artifact)
          .where(
            and(
              eq(artifact.id, artifactId),
              eq(artifact.tenantId, context.tenantId),
            ),
          )
          .for("update")
          .limit(1);

        if (!existing) throw new Error(`Artifact not found: ${artifactId}`);
        if (existing.kind === "skill-draft") {
          throw new Error(
            "skill-draft artifacts must be updated with the skill_draft tool",
          );
        }

        const newVersion = existing.version + 1;
        const title = nextTitle ?? existing.title;
        let content = nextContent ?? existing.content;
        if (nextContent !== undefined) {
          content = normalizeArtifactContentForKind(existing.kind, content);
          assertArtifactContentForKind(existing.kind, content);
        }

        await tx
          .update(artifact)
          .set({ title, content, version: newVersion, updatedAt: now })
          .where(eq(artifact.id, artifactId));

        await tx.insert(artifactVersion).values({
          artifactId,
          version: newVersion,
          title,
          content,
          authorId: context.principalId,
          createdAt: now,
        });

        return jsonResult({ artifactId, version: newVersion, title });
      });
    },
  };
}

function validatePresentationUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("url must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("url must use HTTPS");
  }
}

/**
 * Persist a URL-backed artifact: a new-version bump when `artifactId` is given
 * (guarded on the existing row's kind), otherwise a fresh row. Shared by the
 * presentation and gamma_presentation link handlers.
 */
type UploadSourceRef = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
};

// The `source` to write on a version bump, or `undefined` to leave it as-is.
// A fresh PDF replaces the reference; a requested-but-failed PDF pull clears any
// stale reference so the new deck version never offers the prior deck's PDF; an
// unrequested PDF leaves the existing source untouched.
function computeBumpedSource(
  existingSource: Record<string, unknown> | null,
  uploadRef: UploadSourceRef | null,
  uploadRequested: boolean,
): Record<string, unknown> | undefined {
  if (uploadRef !== null) {
    return { ...(existingSource ?? {}), upload: uploadRef };
  }
  if (
    uploadRequested &&
    existingSource !== null &&
    "upload" in existingSource
  ) {
    const rest = { ...existingSource };
    delete rest.upload;
    return rest;
  }
  return undefined;
}

async function upsertLinkedArtifact(
  context: ArtifactToolContext,
  opts: {
    kind: string;
    title: string;
    content: string;
    artifactId: string | undefined;
    upload?: UploadPayload | null;
    // True when the caller asked for a PDF (even if the fetch yielded none), so
    // a version bump can clear a stale prior PDF rather than leave it pointing
    // at the old deck.
    uploadRequested?: boolean;
  },
): Promise<{ artifactId: string; version: number }> {
  const {
    kind,
    title,
    content,
    artifactId,
    upload: uploadPayload,
    uploadRequested = false,
  } = opts;
  const now = new Date();

  // Persist the PDF bytes and return the download reference to fold into the
  // artifact `source`. Serving is handled by GET /artifacts/:id/download, which
  // keys off `source.upload.id`.
  const insertUpload = async (
    tx: Parameters<Parameters<DB["db"]["transaction"]>[0]>[0],
  ): Promise<UploadSourceRef | null> => {
    if (!uploadPayload) return null;
    const [uploadRow] = await tx
      .insert(upload)
      .values({
        tenantId: context.tenantId,
        principalId: context.principalId,
        filename: uploadPayload.filename,
        mimeType: uploadPayload.mimeType,
        content: uploadPayload.content,
        size: uploadPayload.size,
      })
      .returning();
    if (!uploadRow) throw new Error("Failed to store upload");
    return {
      id: uploadRow.id,
      filename: uploadPayload.filename,
      mimeType: uploadPayload.mimeType,
      size: uploadPayload.size,
    };
  };

  if (artifactId !== undefined) {
    return await context.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(artifact)
        .where(
          and(
            eq(artifact.id, artifactId),
            eq(artifact.tenantId, context.tenantId),
          ),
        )
        .for("update")
        .limit(1);

      if (!existing) throw new Error(`Artifact not found: ${artifactId}`);
      if (existing.kind !== kind) {
        throw new Error(`Artifact ${artifactId} is not a ${kind} artifact`);
      }

      const newVersion = existing.version + 1;
      const uploadRef = await insertUpload(tx);
      const nextSource = computeBumpedSource(
        existing.source,
        uploadRef,
        uploadRequested,
      );

      await tx
        .update(artifact)
        .set({
          title,
          content,
          version: newVersion,
          updatedAt: now,
          ...(nextSource !== undefined ? { source: nextSource } : {}),
        })
        .where(eq(artifact.id, artifactId));

      await tx.insert(artifactVersion).values({
        artifactId,
        version: newVersion,
        title,
        content,
        authorId: context.principalId,
        createdAt: now,
      });

      return { artifactId, version: newVersion };
    });
  }

  const ownerMemberId = await resolveOwnerMemberPrincipalId(
    context.db,
    context,
  );
  assertSessionContext(context);

  const row = await context.db.transaction(async (tx) => {
    const uploadRef = await insertUpload(tx);
    const source = {
      origin: "agent",
      type: "inline",
      agentId: context.agentId,
      sessionId: context.sessionId,
      ...(uploadRef !== null ? { upload: uploadRef } : {}),
    };

    const [created] = await tx
      .insert(artifact)
      .values({
        tenantId: context.tenantId,
        principalId: context.principalId,
        ownerPrincipalId: ownerMemberId ?? null,
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

    if (!created) throw new Error("Failed to create artifact");

    await tx.insert(artifactVersion).values({
      artifactId: created.id,
      version: 1,
      title,
      content,
      authorId: context.principalId,
      createdAt: now,
    });

    return created;
  });

  return { artifactId: row.id, version: 1 };
}

function createLinkPresentationHandler(
  context: ArtifactToolContext,
): AgentTool {
  return {
    kind: "string",
    definition: ARTIFACT_LINK_PRESENTATION_DEFINITION,
    handler: async (args) => {
      const url = requiredString(args, "url");
      validatePresentationUrl(url);
      const title = requiredString(args, "title");
      const artifactId = optionalNonEmptyString(args, "artifactId");

      const { artifactId: id, version } = await upsertLinkedArtifact(context, {
        kind: "presentation",
        title,
        content: url,
        artifactId,
      });

      return jsonResult({ artifactId: id, version, url });
    },
  };
}

function createLinkGammaPresentationHandler(
  context: ArtifactToolContext,
): AgentTool {
  return {
    kind: "string",
    definition: ARTIFACT_LINK_GAMMA_PRESENTATION_DEFINITION,
    handler: async (args, signal) => {
      const url = requiredString(args, "url");
      validatePresentationUrl(url);
      const title = requiredString(args, "title");
      const description = requiredString(args, "description");
      const gammaId = requiredString(args, "gammaId");
      // A present-but-empty pdfUrl ("") means a PDF was requested but Gamma
      // returned no export link (the workflow's create tool always emits the
      // key). Treat that as "requested, none available" — not an error and not
      // "no request": on a version bump it still clears a stale prior PDF. Only
      // a genuinely absent key means no PDF was requested at all.
      const pdfUrlRaw = optionalString(args, "pdfUrl");
      const uploadRequested = pdfUrlRaw !== undefined;
      const pdfUrl =
        pdfUrlRaw !== undefined && pdfUrlRaw.trim().length > 0
          ? pdfUrlRaw.trim()
          : undefined;
      const artifactId = optionalNonEmptyString(args, "artifactId");

      const content = JSON.stringify(
        GammaPresentationContentSchema.assert({ url, description, gammaId }),
      );

      const uploadPayload = pdfUrl
        ? await fetchGammaPresentationPdf(context, pdfUrl, title, signal)
        : null;

      const { artifactId: id, version } = await upsertLinkedArtifact(context, {
        kind: "gamma_presentation",
        title,
        content,
        artifactId,
        upload: uploadPayload,
        uploadRequested,
      });

      return jsonResult({ artifactId: id, version, url });
    },
  };
}

function createFindByTitleHandler(context: ArtifactToolContext): AgentTool {
  return {
    kind: "string",
    definition: ARTIFACT_FIND_BY_TITLE_DEFINITION,
    handler: async (args) => {
      const title = requiredString(args, "title");
      const kind = optionalString(args, "kind");

      if (kind === "skill-draft") return jsonResult(null);

      const conditions = [
        eq(artifact.tenantId, context.tenantId),
        eq(artifact.title, title),
        ne(artifact.kind, "skill-draft"),
      ];
      if (kind !== undefined) conditions.push(eq(artifact.kind, kind));

      const [row] = await context.db
        .select({ id: artifact.id, version: artifact.version })
        .from(artifact)
        .where(and(...conditions))
        .orderBy(desc(artifact.updatedAt))
        .limit(1);

      if (!row) return jsonResult(null);

      return jsonResult({ artifactId: row.id, version: row.version });
    },
  };
}

function createListHandler(context: ArtifactToolContext): AgentTool {
  return {
    kind: "string",
    definition: ARTIFACT_LIST_DEFINITION,
    handler: async (args) => {
      const kind = optionalString(args, "kind");
      // skill-draft is not a gallery kind — only skill_draft / Skills UI.
      if (kind === "skill-draft") {
        return jsonResult({ artifacts: [] });
      }
      const status = optionalStatus(args);
      const rawLimit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? args.limit
          : DEFAULT_LIST_LIMIT;
      const limit = Math.min(Math.max(1, Math.floor(rawLimit)), MAX_LIST_LIMIT);

      const conditions = [
        eq(artifact.tenantId, context.tenantId),
        ne(artifact.kind, "skill-draft"),
      ];
      if (kind !== undefined) conditions.push(eq(artifact.kind, kind));
      if (status !== undefined) conditions.push(eq(artifact.status, status));

      const rows = await context.db
        .select({
          id: artifact.id,
          title: artifact.title,
          kind: artifact.kind,
          status: artifact.status,
          version: artifact.version,
          updatedAt: artifact.updatedAt,
        })
        .from(artifact)
        .where(and(...conditions))
        .orderBy(desc(artifact.updatedAt))
        .limit(limit);

      return jsonResult({ artifacts: rows });
    },
  };
}

export function createArtifactTools(context: ArtifactToolContext): AgentTool[] {
  return [
    createLinkFileHandler(context),
    createCreateHandler(context),
    createReadHandler(context),
    createReadChunkHandler(context),
    createWriteHandler(context),
    createListHandler(context),
    createLinkPresentationHandler(context),
    createLinkGammaPresentationHandler(context),
    createFindByTitleHandler(context),
  ];
}

function artifactToolEntry(definition: ToolDefinition) {
  return { definition, createTools: createArtifactTools };
}

export const ARTIFACT_HUB_TOOLS = {
  artifact_link_file: artifactToolEntry(ARTIFACT_LINK_FILE_DEFINITION),
  artifact_create: artifactToolEntry(ARTIFACT_CREATE_DEFINITION),
  artifact_read: artifactToolEntry(ARTIFACT_READ_DEFINITION),
  artifact_read_chunk: artifactToolEntry(ARTIFACT_READ_CHUNK_DEFINITION),
  artifact_write: artifactToolEntry(ARTIFACT_WRITE_DEFINITION),
  artifact_list: artifactToolEntry(ARTIFACT_LIST_DEFINITION),
  artifact_link_presentation: artifactToolEntry(
    ARTIFACT_LINK_PRESENTATION_DEFINITION,
  ),
  artifact_link_gamma_presentation: artifactToolEntry(
    ARTIFACT_LINK_GAMMA_PRESENTATION_DEFINITION,
  ),
  artifact_find_by_title: artifactToolEntry(ARTIFACT_FIND_BY_TITLE_DEFINITION),
};
