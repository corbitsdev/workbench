import { and, eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import {
  filterPinnedEntriesForSurface,
  isPinnedSkillTriageRelevant,
  MAX_PINNED_MYRA_SKILLS,
  myraSurfaceForTemplateKey,
  oneLineSkillDescription,
  renderPinnedSkillsSection,
  type PinnedSkillIndexEntry,
} from "@workbench/myra";
import { promptFormatForProvider } from "@workbench/prompts";
import { readMyraVariantPreference } from "../services/myra-variant-preferences";
import { listSkills, type SkillViewer } from "../services/skill-library";
import { memberAgentInstance } from "../db/schema";
import type { HubDb } from "../db";

export async function skillViewerForMemberPrincipal(
  db: HubDb,
  tenantId: string,
  memberPrincipalId: string,
): Promise<SkillViewer | null> {
  const row = await db.query.principal.findFirst({
    where: and(
      eq(intxSchema.principal.id, memberPrincipalId),
      eq(intxSchema.principal.tenantId, tenantId),
      eq(intxSchema.principal.kind, "user"),
    ),
  });
  if (!row?.refId) return null;
  return { tenantId, userId: row.refId };
}

/**
 * Resolve pinned ids to index entries; dangling ids are skipped; order preserved.
 */
export async function resolvePinnedSkillIndexEntries(
  db: HubDb,
  viewer: SkillViewer,
  pinnedSkillIds: readonly string[],
): Promise<{
  entries: PinnedSkillIndexEntry[];
  triageRelevant: boolean[];
}> {
  const skills = await listSkills(db, viewer);
  const byId = new Map(skills.map((s) => [s.id, s]));
  const entries: PinnedSkillIndexEntry[] = [];
  const triageRelevant: boolean[] = [];
  const seen = new Set<string>();

  for (const id of pinnedSkillIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const skill = byId.get(id);
    if (!skill) continue;
    entries.push({
      name: skill.displayName ?? skill.name,
      description: oneLineSkillDescription(skill.description),
    });
    triageRelevant.push(isPinnedSkillTriageRelevant(skill.description));
    if (entries.length >= MAX_PINNED_MYRA_SKILLS) break;
  }

  return { entries, triageRelevant };
}

export async function composeMyraPinnedSkillsSectionForInstance(
  db: HubDb,
  opts: { tenantId: string; instanceId: string; provider: string },
): Promise<string | null> {
  const mapping = await db.query.memberAgentInstance.findFirst({
    where: and(
      eq(memberAgentInstance.tenantId, opts.tenantId),
      eq(memberAgentInstance.instanceId, opts.instanceId),
    ),
  });
  if (!mapping) return null;

  const surface = myraSurfaceForTemplateKey(mapping.templateKey);
  if (!surface) return null;

  const viewer = await skillViewerForMemberPrincipal(
    db,
    opts.tenantId,
    mapping.memberPrincipalId,
  );
  if (!viewer) return null;

  const pref = await readMyraVariantPreference(
    db,
    opts.tenantId,
    mapping.memberPrincipalId,
  );
  if (pref.pinnedSkillIds.length === 0) return null;

  const { entries, triageRelevant } = await resolvePinnedSkillIndexEntries(
    db,
    viewer,
    pref.pinnedSkillIds,
  );
  const forSurface = filterPinnedEntriesForSurface(
    surface,
    entries,
    triageRelevant,
  );
  if (forSurface.length === 0) return null;

  const format = promptFormatForProvider(opts.provider);
  return renderPinnedSkillsSection(forSurface, format);
}