import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type } from "arktype";
import { getLogger } from "@intx/log";
import type { DB } from "@intx/db";
import { getAncestorChain } from "@intx/db";
import { workbenchTemplate, workbenchTemplateVersion } from "../db/schema";

export const GAMMA_KIND = "gamma";

const log = getLogger("hub:gamma-templates");

// Persisted config blob for a Gamma template version. Crosses the DB boundary
// (stored as jsonb, read back untrusted), so it is an exported arktype schema.
export const GammaTemplateConfigSchema = type({
  gammaId: "string",
  description: "string",
  "systemPrompt?": "string",
});
export type GammaTemplateConfig = typeof GammaTemplateConfigSchema.infer;

// Projected row shape returned to the route/tool layers. `canManage` is added
// per-caller by the route; this is the plain projection.
export const GammaTemplateRowSchema = type({
  id: "string",
  version: "number",
  name: "string",
  gammaId: "string",
  description: "string",
  systemPrompt: "string",
  authorId: "string",
  createdAt: "string",
});
export type GammaTemplateRow = typeof GammaTemplateRowSchema.infer;

// Tolerant read: gammaId is required (throws if absent), but description
// falls back to a legacy `systemPrompt` config field and then to "" — legacy
// rows must never block a read.
export function configToRow(
  templateId: string,
  version: number,
  name: string,
  config: Record<string, unknown>,
  authorId: string,
  createdAt: Date,
): GammaTemplateRow {
  const gammaId = config["gammaId"];

  if (typeof gammaId !== "string" || gammaId === "") {
    throw new Error(
      `Template ${templateId} has invalid config: gammaId must be a non-empty string`,
    );
  }

  const description = resolveDescription(config);
  const systemPrompt =
    typeof config["systemPrompt"] === "string" ? config["systemPrompt"] : "";

  const row = GammaTemplateRowSchema({
    id: templateId,
    version,
    name,
    gammaId,
    description,
    systemPrompt,
    authorId,
    createdAt: createdAt.toISOString(),
  });
  if (row instanceof type.errors) {
    throw new Error(
      `Template ${templateId} has invalid config: ${row.summary}`,
    );
  }
  return row;
}

type TemplateVersionRow = {
  id: string;
  version: number;
  name: string;
  config: Record<string, unknown>;
  authorId: string;
  createdAt: Date;
};

// Projects the version rows to template rows, skipping (not throwing on) a row
// whose config fails validation — one corrupt legacy row (e.g. a missing
// gammaId) must not 500 the whole list. Only the expected malformed-config
// error is swallowed; anything else propagates.
function projectTemplateRows(rows: TemplateVersionRow[]): GammaTemplateRow[] {
  const out: GammaTemplateRow[] = [];
  for (const r of rows) {
    try {
      out.push(
        configToRow(r.id, r.version, r.name, r.config, r.authorId, r.createdAt),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("invalid config")
      ) {
        throw error;
      }
      log.warn("Skipping Gamma template with invalid config", {
        templateId: r.id,
        reason: error.message,
      });
    }
  }
  return out;
}

function resolveDescription(config: Record<string, unknown>): string {
  const description = config["description"];
  if (typeof description === "string" && description !== "") {
    return description;
  }
  const legacy = config["systemPrompt"];
  if (typeof legacy === "string") {
    return legacy;
  }
  return "";
}

// Uses DB['db'] (not HubDb) so this function is callable from both the route
// (HubDb is a superset) and the ContextToolEntry (receives DB['db']).
export async function listLatestGammaTemplates(
  db: DB["db"],
  tenantId: string,
): Promise<GammaTemplateRow[]> {
  const rows = await db
    .select({
      id: workbenchTemplate.id,
      version: workbenchTemplateVersion.version,
      name: workbenchTemplateVersion.name,
      config: workbenchTemplateVersion.config,
      authorId: workbenchTemplateVersion.authorId,
      createdAt: workbenchTemplateVersion.createdAt,
    })
    .from(workbenchTemplate)
    .innerJoin(
      workbenchTemplateVersion,
      and(
        eq(workbenchTemplateVersion.templateId, workbenchTemplate.id),
        eq(
          workbenchTemplateVersion.version,
          sql<number>`(SELECT MAX(v2.version) FROM template_version v2 WHERE v2.template_id = ${workbenchTemplate.id})`,
        ),
      ),
    )
    .where(
      and(
        eq(workbenchTemplate.tenantId, tenantId),
        eq(workbenchTemplate.kind, GAMMA_KIND),
      ),
    )
    .orderBy(desc(workbenchTemplate.createdAt));

  return projectTemplateRows(rows);
}

// Reads templates visible to a tenant: its own plus those inherited from any
// ancestor (active workbench -> ... -> global). Writes still land in a single
// tenant; only reads walk the chain.
export async function listInheritedGammaTemplates(
  db: DB["db"],
  tenantId: string,
): Promise<GammaTemplateRow[]> {
  const chain = await getAncestorChain(db, tenantId);
  const rows = await db
    .select({
      id: workbenchTemplate.id,
      version: workbenchTemplateVersion.version,
      name: workbenchTemplateVersion.name,
      config: workbenchTemplateVersion.config,
      authorId: workbenchTemplateVersion.authorId,
      createdAt: workbenchTemplateVersion.createdAt,
    })
    .from(workbenchTemplate)
    .innerJoin(
      workbenchTemplateVersion,
      and(
        eq(workbenchTemplateVersion.templateId, workbenchTemplate.id),
        eq(
          workbenchTemplateVersion.version,
          sql<number>`(SELECT MAX(v2.version) FROM template_version v2 WHERE v2.template_id = ${workbenchTemplate.id})`,
        ),
      ),
    )
    .where(
      and(
        inArray(workbenchTemplate.tenantId, chain),
        eq(workbenchTemplate.kind, GAMMA_KIND),
      ),
    )
    .orderBy(desc(workbenchTemplate.createdAt));

  return projectTemplateRows(rows);
}
