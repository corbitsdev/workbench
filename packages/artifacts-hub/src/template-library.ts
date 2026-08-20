/**
 * The bench library's workbench-template shelf (CL-6344): seeding the
 * shipped template manifests in as versioned artifact rows, and the
 * tenant-scoped read routes a create flow instantiates from.
 *
 * Idempotency follows CL-6375's preset-key pattern: each template's
 * stable `id` is the artifact title under the one
 * `workbench-template` kind, so a re-seed finds the existing row and
 * either leaves it alone (content unchanged) or writes a new version
 * (the shipped manifest moved — definition-history already versions,
 * and instances opt in to updates on their own schedule). Boot twice,
 * one library entry.
 *
 * The engine calls are injected the same way `apps/hub`'s
 * `artifacts-mount.ts` injects its engine seam, so seeding logic is
 * testable without a live Postgres.
 */
import {
  anonymousIdentity,
  createArtifact,
  findArtifactByTitle,
  getArtifact,
  listArtifacts,
  writeArtifactVersion,
  type ArtifactDb,
} from "@corbits/artifacts";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
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
  readonly outcome: "created" | "unchanged" | "revised";
};

export type TemplateLibraryEngine = {
  createArtifact: typeof createArtifact;
  findArtifactByTitle: typeof findArtifactByTitle;
  getArtifact: typeof getArtifact;
  writeArtifactVersion: typeof writeArtifactVersion;
  listArtifacts: typeof listArtifacts;
};

const productionEngine: TemplateLibraryEngine = {
  createArtifact,
  findArtifactByTitle,
  getArtifact,
  writeArtifactVersion,
  listArtifacts,
};

export type SeedTemplateLibraryArgs = {
  db: ArtifactDb;
  scope: { tenantId: string; principalId: string };
  entries: readonly TemplateLibraryEntry[];
  engine?: TemplateLibraryEngine;
};

export async function seedTemplateLibrary(
  args: SeedTemplateLibraryArgs,
): Promise<readonly TemplateSeedOutcome[]> {
  const engine = args.engine ?? productionEngine;
  const outcomes: TemplateSeedOutcome[] = [];
  for (const entry of args.entries) {
    const existing = await engine.findArtifactByTitle(
      args.db,
      args.scope.tenantId,
      entry.id,
      WORKBENCH_TEMPLATE_ARTIFACT_KIND,
    );
    if (existing === null) {
      await args.db.transaction(async (tx) => {
        await engine.createArtifact(tx, {
          scope: args.scope,
          ownerPrincipalId: null,
          kind: WORKBENCH_TEMPLATE_ARTIFACT_KIND,
          title: entry.id,
          content: entry.content,
          source: { origin: "template-library-seed", templateId: entry.id },
        });
      });
      outcomes.push({ id: entry.id, outcome: "created" });
      continue;
    }
    const row = await engine.getArtifact(args.db, existing.artifactId);
    if (row !== null && row.content === entry.content) {
      outcomes.push({ id: entry.id, outcome: "unchanged" });
      continue;
    }
    await engine.writeArtifactVersion(args.db, {
      scope: args.scope,
      artifactId: existing.artifactId,
      content: entry.content,
    });
    outcomes.push({ id: entry.id, outcome: "revised" });
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
