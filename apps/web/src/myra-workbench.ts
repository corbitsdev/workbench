// Default Myra chat: the product land surface. Composition only — the
// find-or-create logic itself is `@corbits/chat-ui`'s generic
// `createDefaultAgentWorkbench`; this file's job is to name Myra as the
// configured agent and wire it to this app's agent-definitions fetch.

import {
  createDefaultAgentWorkbench,
  findDefinitionByAssetName,
} from "@corbits/chat-ui";
import { WORKFLOW_CATALOG } from "@workbench/templates";

import { listAgentDefinitions, type AgentDefinition } from "./agents-api";

export const MYRA_WORKBENCH_TITLE = "Myra";

/** The seeded workflow asset backing Myra (`packages/seeding/src/seed.ts`
 * deploys it as `assistant`, stamped with catalog displayName "Myra"). A
 * chat's `definitionId` names this deployed definition's row id, never the
 * asset name itself. */
const MYRA_ASSET_NAME = WORKFLOW_CATALOG.find(
  (entry) => entry.displayName === MYRA_WORKBENCH_TITLE,
)?.assetName;

export type { EnsureDefaultAgentWorkbenchResult as EnsureMyraWorkbenchResult } from "@corbits/chat-ui";

const myraWorkbench = createDefaultAgentWorkbench({
  title: MYRA_WORKBENCH_TITLE,
  assetName: MYRA_ASSET_NAME,
});

/** The last workbench id `ensureMyraWorkbench` resolved to, for the shell's
 * col2-wide derivation (CL-5936): "Myra is the active surface" reduces to
 * "the open workbench is the one Talk-to-Myra last landed us on". */
export function isMyraWorkbenchId(workbenchId: string | null): boolean {
  return myraWorkbench.isCachedWorkbenchId(workbenchId);
}

/** Test helper — drop the cached id between cases. */
export function resetMyraWorkbenchCache(): void {
  myraWorkbench.resetCache();
}

/** Myra's deployed agent definition, matched by the seeded `assistant`
 * asset name — never by display name, which is a UI label, not a wire
 * identifier. */
export function findMyraDefinition(
  definitions: readonly AgentDefinition[],
): AgentDefinition | undefined {
  return findDefinitionByAssetName(definitions, MYRA_ASSET_NAME);
}

/**
 * Create (or reopen) the 1:1 chat against Myra's deployed agent definition —
 * the server's `definitionId` dedupe on `POST /workbenches` is the one
 * find-or-reopen path; this call always issues that create and trusts it.
 */
export function ensureMyraWorkbench(tenantId: string) {
  return myraWorkbench.ensure(tenantId, listAgentDefinitions);
}
