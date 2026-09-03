// Default Myra chat: the product land surface. Composition only — the
// find-or-create logic itself is `@corbits/chat-ui`'s generic
// `createDefaultAgentWorkbench`; this file's job is to name Myra as the
// configured agent and wire it to this app's agent-definitions fetch.

import {
  createDefaultAgentWorkbench,
  findWorkbenchByTitle,
  findDefinitionByAssetName,
  isWorkbenchTitleMatch,
  type Workbench,
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

export function isMyraWorkbenchTitle(title: string): boolean {
  return isWorkbenchTitleMatch(title, MYRA_WORKBENCH_TITLE);
}

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

/** Prefer an exact Myra title; first match wins across the given list. */
export function findMyraWorkbench(
  workbenches: readonly Workbench[],
): Workbench | undefined {
  return findWorkbenchByTitle(workbenches, MYRA_WORKBENCH_TITLE);
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
 * List workbench + chat kinds, reuse a Myra-titled row if one exists — a
 * legacy workbench-kind Myra from a bench seeded before CL-5985 included, so
 * no bench ever ends up with two — otherwise create a 1:1 chat against
 * Myra's deployed agent definition.
 */
export function ensureMyraWorkbench(tenantId: string) {
  return myraWorkbench.ensure(tenantId, listAgentDefinitions);
}
