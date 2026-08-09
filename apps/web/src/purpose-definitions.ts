// Definitions the Routines picker may offer: automatable workflows only.
// Channel-host plumbing and agent handles never appear — the catalog is the
// allowlist (mirrored from each workflow package's package.json
// corbits.workflow.automatable flag); isChannelHostDefinitionName is a
// second belt for host names that slip past the catalog.

import { isChannelHostDefinitionName } from "@corbits/chat/channel-host-naming";
import { isAutomatableWorkflowName } from "@corbits/workflow-catalog";

export function purposeDefinitions<T extends { readonly name: string }>(
  definitions: readonly T[],
): readonly T[] {
  return definitions.filter(
    (definition) =>
      !isChannelHostDefinitionName(definition.name) &&
      isAutomatableWorkflowName(definition.name),
  );
}
