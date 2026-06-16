import { and, desc, eq, sql } from 'drizzle-orm';
import type { DB } from '@intx/db';
import { workbenchTemplate, workbenchTemplateVersion } from '../db/schema';

export const GAMMA_KIND = 'gamma';

export type GammaTemplateConfig = {
  gammaId: string;
  systemPrompt: string;
};

export type GammaTemplateRow = {
  id: string;
  version: number;
  name: string;
  gammaId: string;
  systemPrompt: string;
  createdAt: string;
};

export function configToRow(
  templateId: string,
  version: number,
  name: string,
  config: Record<string, unknown>,
  createdAt: Date
): GammaTemplateRow {
  const gammaId = config['gammaId'];
  const systemPrompt = config['systemPrompt'];

  if (typeof gammaId !== 'string' || gammaId === '') {
    throw new Error(`Template ${templateId} has invalid config: gammaId must be a non-empty string`);
  }
  if (typeof systemPrompt !== 'string' || systemPrompt === '') {
    throw new Error(`Template ${templateId} has invalid config: systemPrompt must be a non-empty string`);
  }

  return {
    id: templateId,
    version,
    name,
    gammaId,
    systemPrompt,
    createdAt: createdAt.toISOString(),
  };
}

// Uses DB['db'] (not HubDb) so this function is callable from both the route
// (HubDb is a superset) and the ContextToolEntry (receives DB['db']).
export async function listLatestGammaTemplates(
  db: DB['db'],
  tenantId: string
): Promise<GammaTemplateRow[]> {
  const rows = await db
    .select({
      id: workbenchTemplate.id,
      version: workbenchTemplateVersion.version,
      name: workbenchTemplateVersion.name,
      config: workbenchTemplateVersion.config,
      createdAt: workbenchTemplateVersion.createdAt,
    })
    .from(workbenchTemplate)
    .innerJoin(
      workbenchTemplateVersion,
      and(
        eq(workbenchTemplateVersion.templateId, workbenchTemplate.id),
        eq(
          workbenchTemplateVersion.version,
          sql<number>`(SELECT MAX(v2.version) FROM template_version v2 WHERE v2.template_id = ${workbenchTemplate.id})`
        )
      )
    )
    .where(and(eq(workbenchTemplate.tenantId, tenantId), eq(workbenchTemplate.kind, GAMMA_KIND)))
    .orderBy(desc(workbenchTemplate.createdAt));

  return rows.map((r) => configToRow(r.id, r.version, r.name, r.config, r.createdAt));
}
