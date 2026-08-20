/**
 * The bench library's workbench-template shelf (CL-6344): seeding the
 * shipped template manifests in as versioned artifact rows, and the
 * tenant-scoped read routes a create flow instantiates from.
 *
 * Reconciliation semantics (CL-6400): every boot converges the shelf
 * to the shipped manifests without ever fighting a member. The seed
 * records the hash of the content it last wrote in the artifact's
 * `source` (`seededContentHash`), so a re-seed can tell "the shipped
 * manifest moved" (head content still matches the marker — revise)
 * from "a member edited this" (head content diverged — keep). A
 * template dropped from the manifests is archived (`source.retired`)
 * when still seed-owned, and unarchived + converged when re-added; a
 * member's own archive (no `retired` flag) is respected and never
 * undone. Rows from before the marker existed adopt one when their
 * content still matches the shipped manifest, and are otherwise
 * preserved — ambiguity never clobbers.
 *
 * The engine calls are injected the same way `apps/hub`'s
 * `artifacts-mount.ts` injects its engine seam, so seeding logic is
 * testable without a live Postgres.
 */
import {
  anonymousIdentity,
  artifact,
  createArtifact,
  findArtifactByTitle,
  getArtifact,
  listArtifacts,
  writeArtifactVersion,
  type ArtifactDb,
} from "@corbits/artifacts";
import { sha256 } from "@intx/crypto";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { hexEncode } from "@intx/types";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";

export const WORKBENCH_TEMPLATE_ARTIFACT_KIND = "workbench-template";

/** One shelf entry to seed: the template's stable id and its serialized
 * manifest. Kept as plain strings so this package never depends on
 * `@corbits/workflow-catalog` — the manifest vocabulary stays there. */
export type TemplateLibraryEntry = {
  readonly id: string;
  readonly content: string;
};

export type TemplateSeedOutcome = {
  readonly id: string;
  readonly outcome:
    "created" | "unchanged" | "revised" | "kept" | "retired" | "restored";
};

export type SeededTemplateRow = {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly archivedAt: Date | null;
  readonly source: Record<string, unknown> | null;
};

export type TemplateLibraryEngine = {
  createArtifact: typeof createArtifact;
  findArtifactByTitle: typeof findArtifactByTitle;
  getArtifact: typeof getArtifact;
  writeArtifactVersion: typeof writeArtifactVersion;
  listArtifacts: typeof listArtifacts;
  listSeedRows: (
    db: ArtifactDb,
    tenantId: string,
    kind: string,
  ) => Promise<readonly SeededTemplateRow[]>;
  updateArtifactSource: (
    db: ArtifactDb,
    artifactId: string,
    source: Record<string, unknown>,
  ) => Promise<void>;
  setArtifactArchivedById: (
    db: ArtifactDb,
    artifactId: string,
    archived: boolean,
  ) => Promise<void>;
};

const SEED_ORIGIN = "template-library-seed";

async function contentHash(content: string): Promise<string> {
  return hexEncode(await sha256(content));
}

const productionEngine: TemplateLibraryEngine = {
  createArtifact,
  findArtifactByTitle,
  getArtifact,
  writeArtifactVersion,
  listArtifacts,
  async listSeedRows(db, tenantId, kind) {
    const rows = await db
      .select({
        id: artifact.id,
        title: artifact.title,
        content: artifact.content,
        archivedAt: artifact.archivedAt,
        source: artifact.source,
      })
      .from(artifact)
      .where(
        and(
          eq(artifact.tenantId, tenantId),
          eq(artifact.kind, kind),
          sql`${artifact.source}->>'origin' = ${SEED_ORIGIN}`,
        ),
      );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      content: row.content,
      archivedAt: row.archivedAt,
      source: isRecord(row.source) ? row.source : null,
    }));
  },
  async updateArtifactSource(db, artifactId, source) {
    await db
      .update(artifact)
      .set({ source })
      .where(eq(artifact.id, artifactId));
  },
  async setArtifactArchivedById(db, artifactId, archived) {
    await db
      .update(artifact)
      .set({ archivedAt: archived ? new Date() : null })
      .where(eq(artifact.id, artifactId));
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type SeedTemplateLibraryArgs = {
  db: ArtifactDb;
  scope: { tenantId: string; principalId: string };
  entries: readonly TemplateLibraryEntry[];
  engine?: TemplateLibraryEngine;
};

function templateIdOf(row: SeededTemplateRow): string {
  const templateId = row.source?.templateId;
  return typeof templateId === "string" ? templateId : row.title;
}

function seedMarkerOf(row: SeededTemplateRow): string | undefined {
  const marker = row.source?.seededContentHash;
  return typeof marker === "string" ? marker : undefined;
}

function seedRetiredFlagOf(row: SeededTemplateRow): boolean {
  return row.source?.retired === true;
}

function seedSource(templateId: string, contentHash: string) {
  return {
    origin: SEED_ORIGIN,
    templateId,
    seededContentHash: contentHash,
  };
}

async function reconcileEntry(
  args: SeedTemplateLibraryArgs,
  engine: TemplateLibraryEngine,
  entry: TemplateLibraryEntry,
  row: SeededTemplateRow | undefined,
): Promise<TemplateSeedOutcome["outcome"]> {
  const shippedHash = await contentHash(entry.content);
  if (row === undefined) {
    const titleClash = await engine.findArtifactByTitle(
      args.db,
      args.scope.tenantId,
      entry.id,
      WORKBENCH_TEMPLATE_ARTIFACT_KIND,
    );
    if (titleClash !== null) {
      return "kept";
    }
    await args.db.transaction(async (tx) => {
      await engine.createArtifact(tx, {
        scope: args.scope,
        ownerPrincipalId: null,
        kind: WORKBENCH_TEMPLATE_ARTIFACT_KIND,
        title: entry.id,
        content: entry.content,
        source: seedSource(entry.id, shippedHash),
      });
    });
    return "created";
  }

  const wasSeedRetired = row.archivedAt !== null && seedRetiredFlagOf(row);
  if (row.archivedAt !== null && !wasSeedRetired) {
    return "kept";
  }

  const headHash = await contentHash(row.content);
  const marker = seedMarkerOf(row);
  const seedOwnsHead = marker === headHash;

  if (row.content === entry.content) {
    if (wasSeedRetired) {
      await engine.setArtifactArchivedById(args.db, row.id, false);
    }
    if (marker !== shippedHash || wasSeedRetired) {
      await engine.updateArtifactSource(
        args.db,
        row.id,
        seedSource(entry.id, shippedHash),
      );
    }
    return wasSeedRetired ? "restored" : "unchanged";
  }

  if (!seedOwnsHead) {
    return "kept";
  }

  if (wasSeedRetired) {
    await engine.setArtifactArchivedById(args.db, row.id, false);
  }
  await engine.writeArtifactVersion(args.db, {
    scope: args.scope,
    artifactId: row.id,
    content: entry.content,
  });
  await engine.updateArtifactSource(
    args.db,
    row.id,
    seedSource(entry.id, shippedHash),
  );
  return wasSeedRetired ? "restored" : "revised";
}

async function retireOrphan(
  args: SeedTemplateLibraryArgs,
  engine: TemplateLibraryEngine,
  row: SeededTemplateRow,
): Promise<TemplateSeedOutcome["outcome"]> {
  if (row.archivedAt !== null) {
    return seedRetiredFlagOf(row) ? "retired" : "kept";
  }
  const marker = seedMarkerOf(row);
  const seedOwnsHead = marker === (await contentHash(row.content));
  if (!seedOwnsHead) {
    return "kept";
  }
  await engine.updateArtifactSource(args.db, row.id, {
    origin: SEED_ORIGIN,
    templateId: templateIdOf(row),
    seededContentHash: marker,
    retired: true,
  });
  await engine.setArtifactArchivedById(args.db, row.id, true);
  return "retired";
}

export async function seedTemplateLibrary(
  args: SeedTemplateLibraryArgs,
): Promise<readonly TemplateSeedOutcome[]> {
  const engine = args.engine ?? productionEngine;
  const seedRows = await engine.listSeedRows(
    args.db,
    args.scope.tenantId,
    WORKBENCH_TEMPLATE_ARTIFACT_KIND,
  );
  const rowsByTemplateId = new Map(
    seedRows.map((row) => [templateIdOf(row), row]),
  );
  const shippedIds = new Set(args.entries.map((entry) => entry.id));

  const outcomes: TemplateSeedOutcome[] = [];
  for (const entry of args.entries) {
    const outcome = await reconcileEntry(
      args,
      engine,
      entry,
      rowsByTemplateId.get(entry.id),
    );
    outcomes.push({ id: entry.id, outcome });
  }
  for (const row of seedRows) {
    const templateId = templateIdOf(row);
    if (shippedIds.has(templateId)) continue;
    const outcome = await retireOrphan(args, engine, row);
    outcomes.push({ id: templateId, outcome });
  }
  return outcomes;
}

/** Minimal read port the routes need — production wraps the engine db. */
export type TemplateLibraryStore = {
  list(tenantId: string): Promise<readonly TemplateLibraryEntry[]>;
  get(
    tenantId: string,
    templateId: string,
  ): Promise<TemplateLibraryEntry | null>;
};

export function createTemplateLibraryDbStore(
  db: ArtifactDb,
  engine: TemplateLibraryEngine = productionEngine,
): TemplateLibraryStore {
  return {
    async list(tenantId) {
      const page = await engine.listArtifacts(db, anonymousIdentity, tenantId, {
        kind: WORKBENCH_TEMPLATE_ARTIFACT_KIND,
      });
      const entries: TemplateLibraryEntry[] = [];
      for (const row of page.rows) {
        const full = await engine.getArtifact(db, row.id);
        if (full === null) continue;
        entries.push({ id: full.title, content: full.content });
      }
      return entries;
    },
    async get(tenantId, templateId) {
      const found = await engine.findArtifactByTitle(
        db,
        tenantId,
        templateId,
        WORKBENCH_TEMPLATE_ARTIFACT_KIND,
      );
      if (found === null) return null;
      const row = await engine.getArtifact(db, found.artifactId);
      if (row === null || row.tenantId !== tenantId) return null;
      return { id: row.title, content: row.content };
    },
  };
}

export type CreateTemplateLibraryRoutesDeps = {
  store: TemplateLibraryStore;
  requireGrant: RequireGrant;
};

/** `GET /` lists every seeded template entry; `GET /:templateId` fetches
 * one. Content travels as the seeded string — the client parses it with
 * `@corbits/workflow-catalog`'s manifest schema at its own boundary. */
export function createTemplateLibraryRoutes(
  deps: CreateTemplateLibraryRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get("/", deps.requireGrant("asset:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const entries = await deps.store.list(tenant.id);
    return c.json({ data: entries });
  });

  app.get("/:templateId", deps.requireGrant("asset:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const entry = await deps.store.get(tenant.id, c.req.param("templateId"));
    if (entry === null) {
      return c.json(
        { error: { code: "not_found", message: "Unknown template" } },
        404,
      );
    }
    return c.json(entry);
  });

  return app;
}

/**
 * Honest degraded surface when the artifacts plane is not mounted — the
 * template library lives in the artifacts engine's db, so it is exactly
 * as unavailable as `createUnavailableArtifactRoutes`' routes. Every
 * route answers 503; without this mount the paths 404 and a client
 * cannot tell "not configured" from "template not seeded".
 */
export function createUnavailableTemplateLibraryRoutes(
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
  app.get("/:templateId", requireGrant("asset:*", "read"), unavailable);
  return app;
}
