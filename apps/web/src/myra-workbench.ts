// Myra's deployed agent definition, matched by the seeded `assistant`
// asset name — never by display name, which is a UI label, not a wire
// identifier, and never by a workbench title. Opening a chat with her
// is the generic `openAgentDmChat` / POST `{kind:chat, definitionId,
// reuseExisting}` path, the same as any other agent row.

import { WORKFLOW_CATALOG } from "@corbits/workflow-catalog";

import type { AgentDefinition } from "./agents-api";

const MYRA_ASSET_NAME = WORKFLOW_CATALOG.find(
  (entry) => entry.displayName === "Myra",
)?.assetName;

export function findMyraDefinition(
  definitions: readonly AgentDefinition[],
): AgentDefinition | undefined {
  if (MYRA_ASSET_NAME === undefined) return undefined;
  return definitions.find((definition) => definition.name === MYRA_ASSET_NAME);
}
