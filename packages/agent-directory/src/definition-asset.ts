// Every read and write of an agent definition's asset tree goes through
// here: the source codebase, never the retired `workflow.json` envelope.

import {
  parseWorkflowSourceDefinition,
  readWorkflowSourceDefinition,
  renderWorkflowSourceTree,
  RetiredWorkflowEnvelopeError,
  WORKFLOW_SOURCE_DEFINITION_PATH,
  WORKFLOW_SOURCE_ENTRY,
  type WorkflowSourceBlobReader,
  type WorkflowSourceTree,
  WorkflowAuthorError,
  type WorkflowDeployer,
} from "@corbits/workflows";
import { DEFAULT_ASSET_REF } from "@intx/hub-sessions";
import type { AssetService } from "@intx/hub-sessions";

export {
  RetiredWorkflowEnvelopeError,
  WORKFLOW_SOURCE_DEFINITION_PATH as AGENT_DEFINITION_JSON_PATH,
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

/** The serialized workflow inside definition bytes read at a past commit. */
export function parseAgentDefinitionJson(definitionJson: Uint8Array, assetId: string): string {
  return parseWorkflowSourceDefinition(new TextDecoder().decode(definitionJson), assetId);
}

/** The `WorkflowDeployer` seam this package needs — just the one deploy
 * call, never the whole registry surface; this package never reimplements
 * install/probe/gate/freeze itself. */
export type AgentDefinitionDeployer = Pick<WorkflowDeployer, "deploy">;

/** Writes a definition's serialized workflow into its asset tree, then
 * deploys the resulting commit through the native source pipeline — the
 * one sequence every content-mutating route in this package needs. Throws
 * `WorkflowAuthorError` for the caller's route to translate. */
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
    assetName: args.handle,
    commitSha,
    entry: WORKFLOW_SOURCE_ENTRY,
  });
  return { commitSha };
}

/** The HTTP status a `WorkflowAuthorError` from `writeAndDeployAgentDefinition`
 * should surface as, matching the native deploy surface's own mapping. */
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
