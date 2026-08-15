// Browser-safe "what counts as a user-facing agent" logic: filtering out
// the chat anchor machinery's channel hosts (they are plumbing, not an
// agent a person created), full-text search across the fields a person
// actually reads (never an id), and flagging an instance whose definition
// has since gone missing from the tenant's own listing. Depends directly on
// `@corbits/chat/channel-host-naming` — a domain package, not app state —
// to identify that plumbing; a host injects only its raw definition/
// instance lists, already fetched from wherever it gets them.

import { isChannelHostDefinitionName } from "@corbits/chat/channel-host-naming";

export type UserFacingAgentDefinition = {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
};

export type UserFacingAgentInstance = {
  readonly definitionId: string;
  readonly definitionName: string;
};

/** Every definition, minus the chat anchor machinery's channel hosts —
 * those are internal plumbing, never a user-facing agent. */
export function purposeAgentDefinitions<T extends UserFacingAgentDefinition>(
  definitions: readonly T[],
): readonly T[] {
  return definitions.filter((d) => !isChannelHostDefinitionName(d.name));
}

export function purposeAgentInstances<T extends UserFacingAgentInstance>(
  instances: readonly T[],
): readonly T[] {
  return instances.filter(
    (instance) => !isChannelHostDefinitionName(instance.definitionName),
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
