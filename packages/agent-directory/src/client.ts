// Browser-safe "what counts as a user-facing agent" logic: filtering out
// workbench-host plumbing, full-text search across fields a person actually
// reads, and flagging an instance whose definition has gone missing.

import {
  deriveDisplayName,
  humanizeSlug,
  withDisplayName,
  withDisplayNames,
  type WithDisplayName,
} from "./display-name";
import { isConversationalWorkflowName } from "@corbits/workflows/catalog";

// Re-exported from `./display-name` so every existing caller of this
// module's `deriveDisplayName`/`humanizeSlug` keeps working unchanged.
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

/** Every definition minus workbench-host plumbing and minus every
 * non-conversational workflow-catalog utility. `isConversationalWorkflowName`
 * is the one distinguishing property; `automatable` is orthogonal. */
export function purposeAgentDefinitions<T extends UserFacingAgentDefinition>(
  definitions: readonly T[],
): readonly T[] {
  return definitions.filter((d) => isConversationalWorkflowName(d.name));
}

/** `excludeRunIds` additionally drops chat-plumbing runs (invited agents),
 * which a name-based filter never catches. Defaults to empty. */
export function purposeAgentInstances<T extends UserFacingAgentInstance>(
  instances: readonly T[],
  excludeRunIds: ReadonlySet<string> = new Set(),
): readonly T[] {
  return instances.filter((instance) => !excludeRunIds.has(instance.id));
}

export function filterDefinitions<T extends UserFacingAgentDefinition>(
  definitions: readonly T[],
  query: string,
): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return definitions;
  return definitions.filter(
    (d) =>
      d.name.toLowerCase().includes(needle) || (d.description ?? "").toLowerCase().includes(needle),
  );
}

export function filterInstances<T extends UserFacingAgentInstance>(
  instances: readonly T[],
  query: string,
): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return instances;
  return instances.filter((i) => i.definitionName.toLowerCase().includes(needle));
}

/** An instance is orphaned when the tenant's own definitions listing no
 * longer carries its `definitionId` — never hide it, mark it instead. */
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
