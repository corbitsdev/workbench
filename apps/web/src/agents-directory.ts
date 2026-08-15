// Pure logic for the Agents directory: filtering out the chat anchor
// machinery's channel hosts (they are plumbing, not an agent a person
// created), full-text search across the fields a person actually reads
// (never an id), and flagging an instance whose definition has since
// gone missing from the tenant's own listing. Shared by shell col2 and
// the agents page so neither layer imports the other.

import { isChannelHostDefinitionName } from "@corbits/chat/channel-host-naming";

import type { AgentDefinition, AgentInstance } from "./agents-api";

/** Every definition and instance a bench holds, minus the chat anchor
 * machinery's channel hosts — those are internal plumbing, never a
 * user-facing agent. Definitions never need the folded-run-id filter
 * `purposeAgentInstances` below takes: `WorkflowDefinition` rows aren't
 * `workflowRun` rows, so the self-anchor leak (a run's own id newly
 * matching a run-scoped predicate) can't reach this listing — an
 * invited agent's real `definitionId` stays a legitimate, reusable
 * template even though its *instance* is chat plumbing. */
export function purposeAgentDefinitions(
  definitions: readonly AgentDefinition[],
): readonly AgentDefinition[] {
  return definitions.filter((d) => !isChannelHostDefinitionName(d.name));
}

/**
 * `foldedRunIds` additionally excludes invited-agent chat runs: since
 * `packages/folded-runs/src/launch.ts` self-anchors every folded run
 * (`anchorRunId === id`, matching a real deployment's shape), the tenant
 * runs listing this reads from now includes them too, and they launch
 * under a real, user-authored `definitionId` (see
 * `packages/chat/src/platform-adapter.ts`'s `launchInvite`) that
 * `isChannelHostDefinitionName` never catches. Defaults to an empty set
 * so callers that haven't threaded the fetch through yet keep today's
 * behavior rather than failing to compile.
 */
export function purposeAgentInstances(
  instances: readonly AgentInstance[],
  foldedRunIds: ReadonlySet<string> = new Set(),
): readonly AgentInstance[] {
  return instances.filter(
    (instance) =>
      !isChannelHostDefinitionName(instance.definitionName) &&
      !foldedRunIds.has(instance.id),
  );
}

export function filterDefinitions(
  definitions: readonly AgentDefinition[],
  query: string,
): readonly AgentDefinition[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return definitions;
  return definitions.filter(
    (d) =>
      d.name.toLowerCase().includes(needle) ||
      (d.description ?? "").toLowerCase().includes(needle),
  );
}

export function filterInstances<T extends AgentInstance>(
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
  instance: AgentInstance,
  definitionsById: ReadonlyMap<string, AgentDefinition>,
): boolean {
  return !definitionsById.has(instance.definitionId);
}

export function definitionsById(
  definitions: readonly AgentDefinition[],
): ReadonlyMap<string, AgentDefinition> {
  return new Map(definitions.map((d) => [d.id, d]));
}
