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
  WORKFLOW_SOURCE_ENTRY_PATH,
  type WorkflowSourceBlobReader,
  type WorkflowSourceTree,
} from "@corbits/workflow-source";

export {
  RetiredWorkflowEnvelopeError,
  WORKFLOW_SOURCE_ENTRY_PATH as AGENT_DEFINITION_ENTRY_PATH,
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
