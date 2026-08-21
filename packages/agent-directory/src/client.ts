// Browser-safe "what counts as a user-facing agent" logic: filtering out
// the chat anchor machinery's workbench hosts (they are plumbing, not an
// agent a person created), full-text search across the fields a person
// actually reads (never an id), and flagging an instance whose definition
// has since gone missing from the tenant's own listing. Depends directly on
// `@corbits/chat/workbench-host-naming` — a domain package, not app state —
// to identify that plumbing; a host injects only its raw definition/
// instance lists, already fetched from wherever it gets them.

import { isWorkbenchHostDefinitionName } from "@corbits/chat/workbench-host-naming";
import {
  deriveDisplayName,
  humanizeSlug,
  withDisplayName,
  withDisplayNames,
  type WithDisplayName,
} from "@corbits/chat/display-name";

// `deriveDisplayName`/`humanizeSlug` (CL-6413) live in `@corbits/chat`
// itself, not here: this package already depends on `@corbits/chat` (for
// `isWorkbenchHostDefinitionName` below), so a copy defined here could
// never be imported back by `@corbits/chat`'s own call sites without a
// circular dependency — exactly the gap CL-6471 traces the "Run
// 737a058d…" leak to (the chat participant invite/greeting path never
// migrated onto this derivation because it couldn't). Re-exported here so
// every existing caller of `@corbits/agent-directory/client`'s
// `deriveDisplayName`/`humanizeSlug` keeps working unchanged.
export { deriveDisplayName, humanizeSlug, withDisplayName, withDisplayNames };
export type { WithDisplayName };

export type UserFacingAgentDefinition = {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
};

export type UserFacingAgentInstance = {
  readonly id: string;
  readonly definitionId: string;
  readonly definitionName: string;
  readonly address?: string;
};

/** Every definition, minus the chat anchor machinery's workbench hosts —
 * those are internal plumbing, never a user-facing agent. Definitions
 * never need the run-id filter `purposeAgentInstances` below takes:
 * definition rows aren't run rows, so a folded run's own id can never
 * match here — an invited agent's real `definitionId` stays a
 * legitimate, reusable template even though its *instance* is chat
 * plumbing. */
export function purposeAgentDefinitions<T extends UserFacingAgentDefinition>(
  definitions: readonly T[],
): readonly T[] {
  return definitions.filter((d) => !isWorkbenchHostDefinitionName(d.name));
}

/**
 * `excludeRunIds` additionally drops folded chat runs (invited agents):
 * they self-anchor like a real deployment and launch under a real,
 * user-authored `definitionId` that `isWorkbenchHostDefinitionName` never
 * catches, so the host names them by id instead. Defaults to an empty
 * set so callers without a folded-run source keep the name-only filter.
 */
export function purposeAgentInstances<T extends UserFacingAgentInstance>(
  instances: readonly T[],
  excludeRunIds: ReadonlySet<string> = new Set(),
): readonly T[] {
  return instances.filter(
    (instance) =>
      !isWorkbenchHostDefinitionName(instance.definitionName) &&
      !excludeRunIds.has(instance.id),
  );
}

export function filterDefinitions<T extends UserFacingAgentDefinition>(
  definitions: readonly T[],
  query: string,
): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return definitions;
  return definitions.filter(
    (d) =>
      d.name.toLowerCase().includes(needle) ||
      (d.description ?? "").toLowerCase().includes(needle),
  );
}

export function filterInstances<T extends UserFacingAgentInstance>(
  instances: readonly T[],
  query: string,
): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return instances;
  return instances.filter((i) =>
    i.definitionName.toLowerCase().includes(needle),
  );
}

/**
 * An instance is orphaned when the tenant's own definitions listing no
 * longer carries its `definitionId` — the definition was deleted or,
 * more commonly, has scrolled past the page's fetch window. A
 * definition row's own FK to the run means this can never mean "no
 * definition ever existed"; it means "not resolvable from here", which
 * is exactly the distinction the UI floor cares about: never hide an
 * instance the page cannot fully explain, mark it instead.
 */
export function isOrphanedInstance(
  instance: Pick<UserFacingAgentInstance, "definitionId">,
  definitionsById: ReadonlyMap<string, unknown>,
): boolean {
  return !definitionsById.has(instance.definitionId);
}

export function definitionsById<T extends UserFacingAgentDefinition>(
  definitions: readonly T[],
): ReadonlyMap<string, T> {
  return new Map(definitions.map((d) => [d.id, d]));
}
