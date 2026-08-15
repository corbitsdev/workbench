// Binds `@corbits/agent-directory/client`'s user-facing-agent logic
// (channel-host filtering, search, orphan detection) to this app's
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
} from "@corbits/agent-directory/client";

import type { AgentDefinition, AgentInstance } from "./agents-api";

export function purposeAgentDefinitions(
  definitions: readonly AgentDefinition[],
): readonly AgentDefinition[] {
  return purposeAgentDefinitionsShared(definitions);
}

/**
 * `foldedRunIds` excludes invited-agent chat runs — see
 * `packages/folded-runs/src/launch.ts` (self-anchoring) and
 * `packages/chat/src/platform-adapter.ts`'s `launchInvite` for why the
 * shared name-based filter alone can't catch them.
 */
export function purposeAgentInstances(
  instances: readonly AgentInstance[],
  foldedRunIds: ReadonlySet<string> = new Set(),
): readonly AgentInstance[] {
  return purposeAgentInstancesShared(instances, foldedRunIds);
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
