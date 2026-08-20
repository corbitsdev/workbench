// The source form a template's referenced block workflow deploys as —
// the missing half of instantiation CL-6405 closes: `./instantiate.ts`
// resolves a manifest's participants through the agent-directory create
// path, and this module resolves its `blocks` into the same
// source-form deploy (a serialized definition rendered into a
// `@corbits/workflow-source` tree and projected onto a
// `workflow_definition` row — see `./template-block-routes.ts` and the
// hub's `deployWorkflowSource` binding).
//
// Server-only, on purpose: building `code-review`'s definition pulls in
// `@corbits/code-review-workflow` and with it `@intx/agent`/`@intx/workflow`
// — the heavy graph `./templates.ts` keeps every manifest consumer off.
// Only `./template-block-routes.ts` (mounted in `apps/hub`) imports
// this; it is deliberately not re-exported from the package root.

import {
  buildCodeReviewWorkflow,
  serializeCodeReviewWorkflow,
  type CodeReviewWorkflowInput,
} from "@corbits/code-review-workflow";

import { workflowCatalogEntry } from "./index";

// Matches the conversational default every folded builder in this
// codebase uses (`AGENT_DEFINITION_TURN_TIMEOUT_MS`,
// `ASSISTANT_TURN_TIMEOUT_MS`): a review turn reads a diff and posts
// one review, the same order of work as a research or assistant turn.
const BLOCK_WORKFLOW_TURN_TIMEOUT_MS = 2 * 60 * 1000;

export interface BlockWorkflowBuildInput {
  readonly tenantDomain: string;
  readonly inferencePreferences: CodeReviewWorkflowInput["inferencePreferences"];
}

export interface BlockWorkflowSource {
  readonly assetName: string;
  readonly displayName: string;
  readonly workflowJson: string;
}

/**
 * The serialized source-form definition for one template block, or
 * `undefined` for an asset name no template block builder covers yet —
 * the GTM blocks resolve through their own (future) path, exactly like
 * `instantiateWorkbenchTemplate`'s participants; a route answering
 * `undefined` as a 404 is the honest statement of that gap.
 */
export function buildBlockWorkflowSource(
  assetName: string,
  input: BlockWorkflowBuildInput,
): BlockWorkflowSource | undefined {
  if (assetName !== "code-review") return undefined;
  const definition = buildCodeReviewWorkflow({
    triggerAddress: `${assetName}@${input.tenantDomain}`,
    inferencePreferences: input.inferencePreferences,
    turnTimeoutMs: BLOCK_WORKFLOW_TURN_TIMEOUT_MS,
  });
  return {
    assetName,
    displayName: workflowCatalogEntry(assetName)?.displayName ?? assetName,
    workflowJson: serializeCodeReviewWorkflow(definition),
  };
}
