// Every read and write of an agent definition's asset tree goes through
// here, so this lineage has exactly one notion of what a definition's
// asset holds: the source codebase `@corbits/workflow-source` renders,
// never the retired `workflow.json` envelope the push validator now
// refuses.
//
// The rendered package's name never leaves the asset — the tree is a
// standalone codebase the sidecar evaluates, not something anyone
// installs — so it only has to be a valid, stable npm name. A
// definition's handle is already lowercase-kebab (see `./validation.ts`),
// which makes it one.

import {
  parseWorkflowSourceEntry,
  readWorkflowSourceDefinition,
  renderWorkflowSourceTree,
  RetiredWorkflowEnvelopeError,
  WORKFLOW_SOURCE_ENTRY,
  WORKFLOW_SOURCE_ENTRY_PATH,
  type WorkflowSourceBlobReader,
  type WorkflowSourceTree,
} from "@corbits/workflow-source";
import { DEFAULT_ASSET_REF } from "@intx/hub-sessions";
import type { AssetService } from "@intx/hub-sessions";
import {
  WorkflowAuthorError,
  type WorkflowDeployer,
} from "@corbits/agent-workflow-authoring";

export {
  RetiredWorkflowEnvelopeError,
  WORKFLOW_SOURCE_ENTRY_PATH as AGENT_DEFINITION_ENTRY_PATH,
  WORKFLOW_SOURCE_ENTRY as AGENT_DEFINITION_ENTRY,
};

const AGENT_PACKAGE_SCOPE = "@workbench-agent";

/** The source tree a definition's serialized workflow is written as. */
export function agentDefinitionSourceTree(args: {
  handle: string;
  workflowJson: string;
}): WorkflowSourceTree {
  return renderWorkflowSourceTree({
    packageName: `${AGENT_PACKAGE_SCOPE}/${args.handle}`,
    workflowJson: args.workflowJson,
  });
}

/** A definition's current serialized workflow, read back out of its asset. */
export function readAgentDefinitionWorkflowJson(
  reader: WorkflowSourceBlobReader,
  assetId: string,
): Promise<string> {
  return readWorkflowSourceDefinition(reader, assetId);
}

/** The serialized workflow inside entry-module bytes read at a past commit. */
export function parseAgentDefinitionEntry(
  entryModule: Uint8Array,
  assetId: string,
): string {
  return parseWorkflowSourceEntry(
    new TextDecoder().decode(entryModule),
    assetId,
  );
}

/** The `WorkflowDeployer` seam this package needs — never the whole
 * registry surface, just the one call that deploys a commit through the
 * native source pipeline (install -> sidecar probe -> gate -> freeze).
 * The composition root (`apps/hub`) injects the SAME deployer
 * `@corbits/agent-workflow-authoring`'s own registry calls; this
 * package never reimplements install/probe/gate/freeze itself. */
export type AgentDefinitionDeployer = Pick<WorkflowDeployer, "deploy">;

/**
 * Writes a definition's serialized workflow into its asset tree, then
 * deploys the resulting commit through the native source pipeline — the
 * one sequence every content-mutating route in this package needs
 * (create, restore, capability add, instructions edit, skills edit).
 * Replaces the old write-then-`DefinitionFreezer.freeze`/`refreeze`
 * pair: a deploy IS a freeze, plus the install/probe/gate a bare freeze
 * skipped. Throws `WorkflowAuthorError` on rejection — `not_found`,
 * `invalid` (rejected package/definition), or `unavailable` (sidecar
 * unreachable) — for the caller's route to translate into its response.
 */
export async function writeAndDeployAgentDefinition(args: {
  assetService: AssetService;
  deployer: AgentDefinitionDeployer;
  tenantId: string;
  principalId: string;
  assetId: string;
  handle: string;
  workflowJson: string;
  message: string;
}): Promise<{ commitSha: string }> {
  const { commitSha } = await args.assetService.populateAsset({
    assetId: args.assetId,
    ref: DEFAULT_ASSET_REF,
    principal: { kind: "hub" },
    tree: {
      files: agentDefinitionSourceTree({
        handle: args.handle,
        workflowJson: args.workflowJson,
      }),
      message: args.message,
    },
  });
  await args.deployer.deploy({
    tenantId: args.tenantId,
    principalId: args.principalId,
    assetId: args.assetId,
    commitSha,
    entry: WORKFLOW_SOURCE_ENTRY,
  });
  return { commitSha };
}

/** The HTTP status a `WorkflowAuthorError` from `writeAndDeployAgentDefinition`
 * should surface as — the same mapping `@corbits/agent-workflow-authoring`'s
 * own `workflow-routes.ts` uses for the native deploy surface, reused here
 * so a sidecar-unavailable deploy reads as the same 502 envelope shape
 * everywhere a deploy can fail. */
export function statusForAgentDefinitionDeployError(
  reason: WorkflowAuthorError["reason"],
): 400 | 403 | 404 | 409 | 502 {
  switch (reason) {
    case "not_found":
      return 404;
    case "forbidden":
      return 403;
    case "conflict":
      return 409;
    case "invalid":
      return 400;
    case "unavailable":
      return 502;
  }
}

export { WorkflowAuthorError };
