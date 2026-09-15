// Composition for `@corbits/skills`: the registry itself plus the two
// adapters that only this composition root can supply — "which agent
// definitions pin this skill" (read from each definition's own asset
// snapshot, where its pinned-skills stanza lives) and "what index does
// a definition's pinned names resolve to" (read from the registry, on
// behalf of the pushing principal).
import { and, eq } from "drizzle-orm";

import type { DB } from "@intx/db";
import { workflowDefinition } from "@intx/db/schema";
import { type AssetService, type RepoStore } from "@intx/hub-sessions";
import {
  readAgentDefinitionWorkflowJson,
  readPinnedSkillNames,
  type PinnedSkillIndexResolver,
} from "@corbits/agent-directory";
import { reportError } from "@corbits/error-sink";
import {
  createHubSkillAssetStore,
  createSkillRegistry,
  SkillRegistryError,
  type PinnedByResolver,
  type SkillRegistry,
} from "@corbits/skills";

export type SkillsMount = {
  registry: SkillRegistry;
  pinnedBy: PinnedByResolver;
  skillIndex: PinnedSkillIndexResolver;
};

/** At most this many concurrent asset-blob reads while resolving who
 * pins a skill — a tenant's definition count is unbounded, and one
 * `readAssetBlob` per definition with no cap is a self-inflicted load
 * spike against the asset store. */
const PINNED_BY_READ_CONCURRENCY = 8;

/** Runs `fn` over `items` with at most `limit` in flight, preserving
 * order — the same bounded fan-out every per-row asset read in this
 * composition root needs, so a many-definition tenant cannot open a
 * blob read per definition at once. */
async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await fn(items[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function mountSkills(deps: {
  db: DB["db"];
  assetService: AssetService;
  repoStore: RepoStore;
}): SkillsMount {
  const registry = createSkillRegistry({
    assets: createHubSkillAssetStore({
      db: deps.db,
      assetService: deps.assetService,
      repoStore: deps.repoStore,
    }),
  });

  const pinnedBy: PinnedByResolver = {
    async resolve(tenantId, skillName) {
      const rows = await deps.db.query.workflowDefinition.findMany({
        where: and(eq(workflowDefinition.tenantId, tenantId)),
      });
      const candidates = rows.filter(
        (row): row is typeof row & { assetId: string } => row.assetId !== null,
      );
      // Pins live in each definition's own asset snapshot — the same
      // stanza every agent-directory read goes through. Bounded fan-out
      // instead of the old sequential N+1, and one unreadable asset
      // (a pre-cutover retired envelope, a missing blob) skips its
      // row — reported, never failing the whole resolve.
      const matches = await mapWithConcurrencyLimit(
        candidates,
        PINNED_BY_READ_CONCURRENCY,
        async (row) => {
          try {
            const workflowJson = await readAgentDefinitionWorkflowJson(
              deps.assetService,
              row.assetId,
            );
            return readPinnedSkillNames(workflowJson).includes(skillName)
              ? { definitionId: row.id, name: row.name }
              : null;
          } catch (err) {
            reportError(err, {
              operation: "skills.pinnedBy.resolve",
              tenantId,
              extra: { definitionId: row.id, skillName },
            });
            return null;
          }
        },
      );
      return matches.filter((match) => match !== null);
    },
  };

  const skillIndex: PinnedSkillIndexResolver = {
    async resolve(tenantId, principalId, names) {
      const visible = await registry.list({ tenantId, principalId });
      const byName = new Map(visible.map((skill) => [skill.name, skill]));
      return names.map((name) => {
        const skill = byName.get(name);
        if (skill === undefined) {
          // Pinning a skill the pusher cannot see would advertise a
          // skill `skills_load` will refuse to fetch at run time. Reject
          // the push instead of shipping an index that lies.
          throw new SkillRegistryError(
            "not_found",
            `cannot pin skill "${name}": it is not in this workbench's registry, or not visible to you`,
          );
        }
        return { name: skill.name, description: skill.description };
      });
    },
  };

  return { registry, pinnedBy, skillIndex };
}
