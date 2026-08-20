// Binds `@corbits/agent-directory/client`'s user-facing-agent logic
// (workbench-host filtering, search, orphan detection) to this app's
// concrete `AgentDefinition`/`AgentInstance` types. Shared by shell col2
// and the agents page so neither layer imports the other; the actual
// product rule lives in the package, not here.

import {
  definitionsById as definitionsByIdShared,
  filterDefinitions as filterDefinitionsShared,
  filterInstances as filterInstancesShared,
  isOrphanedInstance as isOrphanedInstanceShared,
  purposeAgentDefinitions as purposeAgentDefinitionsShared,
  purposeAgentInstances as purposeAgentInstancesShared,
  withDisplayName as withDisplayNameShared,
  withDisplayNames as withDisplayNamesShared,
  type WithDisplayName,
} from "@corbits/agent-directory/client";

import type { AgentDefinition, AgentInstance } from "./agents-api";

/** An `AgentDefinition` with its display name derived (CL-6413) — its own
 * description when the definition was created with one, otherwise a
 * humanized reading of its immutable `name` slug. `name` itself stays the
 * slug throughout; nothing here mutates it. */
export type AgentDefinitionWithDisplayName = WithDisplayName<AgentDefinition>;

/** One definition's display name derived the same way the roster's are, so
 * the same agent never reads under two different names across screens. */
export function withAgentDisplayName(
  definition: AgentDefinition,
): AgentDefinitionWithDisplayName {
  return withDisplayNameShared(definition);
}

export function purposeAgentDefinitions(
  definitions: readonly AgentDefinition[],
): readonly AgentDefinitionWithDisplayName[] {
  return withDisplayNamesShared(purposeAgentDefinitionsShared(definitions));
}

/**
 * `instances` is expected to already come from `listTopLevelRuns`
 * (see `./agents-api.ts`), which excludes every folded run (workbench
 * host, invited agent, task) server-side — see
 * `@corbits/folded-runs`'s `scope-routes.ts`. This still applies the
 * shared name-based workbench-host filter as defense in depth.
 */
export function purposeAgentInstances(
  instances: readonly AgentInstance[],
): readonly AgentInstance[] {
  return purposeAgentInstancesShared(instances);
}

export function filterDefinitions(
  definitions: readonly AgentDefinition[],
  query: string,
): readonly AgentDefinition[] {
  return filterDefinitionsShared(definitions, query);
}

export function filterInstances<T extends AgentInstance>(
  instances: readonly T[],
  query: string,
): readonly T[] {
  return filterInstancesShared(instances, query);
}

export function isOrphanedInstance(
  instance: AgentInstance,
  definitionsById: ReadonlyMap<string, AgentDefinition>,
): boolean {
  return isOrphanedInstanceShared(instance, definitionsById);
}

export function definitionsById(
  definitions: readonly AgentDefinition[],
): ReadonlyMap<string, AgentDefinition> {
  return definitionsByIdShared(definitions);
}
