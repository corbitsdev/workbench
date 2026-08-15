// Definitions the Routines picker may offer: automatable workflows only.
// Channel-host plumbing and agent handles never appear — the catalog is the
// allowlist (mirrored from each workflow package's package.json
// corbits.workflow.automatable flag); isChannelHostDefinitionName is a
// second belt for host names that slip past the catalog.

import { isChannelHostDefinitionName } from "@corbits/chat/channel-host-naming";
import {
  isAutomatableWorkflowName,
  workflowCatalogEntry,
} from "@corbits/workflow-catalog";
import type { WorkflowTriggerField } from "@corbits/workflow-catalog";

export function purposeDefinitions<T extends { readonly name: string }>(
  definitions: readonly T[],
): readonly T[] {
  return definitions.filter(
    (definition) =>
      !isChannelHostDefinitionName(definition.name) &&
      isAutomatableWorkflowName(definition.name),
  );
}

export type CatalogFields = {
  /** The raw catalog asset name (e.g. "recurring-task") — distinct from
   * `name`, which a caller (see `listWorkflowDefinitions`) may go on to
   * overwrite with the friendly display name for UI rendering. A caller
   * that needs to recognize a *specific* known workflow (not just show
   * it) must compare against this field, never `name`. */
  readonly assetName: string;
  /** Where this workflow's result actually lands — see
   * `@corbits/workflow-catalog`'s `WorkflowCatalogEntry.deliveryMode`.
   * The create dialog reads this to decide whether to collect (and
   * require) a delivery channel at all. */
  readonly deliveryMode: "channel" | "inbox";
  readonly whatItDoes: string;
  readonly requiredConnections: readonly string[];
  readonly exampleOutput: string;
  readonly typicalDuration: string;
  readonly triggerFields: readonly WorkflowTriggerField[];
};

/**
 * Attaches each catalog entry's demo-card fields, keyed by the raw asset
 * name — call after `purposeDefinitions` so every input is guaranteed
 * catalog-known; an unknown name throws rather than silently rendering a
 * blank card.
 */
export function withCatalogFields<T extends { readonly name: string }>(
  definitions: readonly T[],
): readonly (T & CatalogFields)[] {
  return definitions.map((workflow) => {
    const entry = workflowCatalogEntry(workflow.name);
    if (entry === undefined) {
      throw new Error(
        `No workflow-catalog entry for automatable workflow "${workflow.name}".`,
      );
    }
    return {
      ...workflow,
      assetName: workflow.name,
      deliveryMode: entry.deliveryMode,
      whatItDoes: entry.whatItDoes,
      requiredConnections: entry.requiredConnections,
      exampleOutput: entry.exampleOutput,
      typicalDuration: entry.typicalDuration,
      triggerFields: entry.triggerFields ?? [],
    };
  });
}
