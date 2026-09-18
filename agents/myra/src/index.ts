// Myra's workflow entry: a single-step, mail-triggered conversational
// definition whose agent carries its tool factories inline.
//
// This module is never imported by a browser bundle. It is the entrypoint
// `scripts/build-bundle.ts` bundles into one self-contained ESM file that
// the deploy pushes as the asset's `workflow.js`; the sidecar's
// source-deploy path evaluates that closure and runs `req.agent.toolFactories`
// directly, so the factories must be real functions here rather than
// `toolPackagePins` the source lineage never resolves.

import type { AgentDefinition, AnnotatedToolFactory, InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import { mail } from "@intx/tools-mail/sidecar-bundle";
import { posix } from "@intx/tools-posix/sidecar-bundle";
import { artifacts } from "@corbits/artifacts/sidecar-bundle";

import {
  ASSISTANT_STEP_ID,
  artifactToolsCredentialBinding,
  artifactToolsCredentialUseRequirement,
} from "./workflow-ids";

export { ASSISTANT_SYSTEM_PROMPT } from "./system-prompt";
export { ASSISTANT_STEP_ID, ASSISTANT_WORKFLOW_ID } from "./workflow-ids";

/** The description the agent step carries; mirrored by the JSON projection
 * the deploy writes beside the entry, so both must stay identical. */
export const ASSISTANT_DESCRIPTION =
  "A general-purpose assistant that answers questions, drafts " +
  "text, and reasons through problems for the team";

// Tool packages in the shape Interchange has: mail over the agent's
// transport, posix over its working tree, and artifacts through the hub
// credential the deploy binds — the agent itself holds no client code and
// no secret.
export const MYRA_TOOL_FACTORIES = [
  mail,
  posix,
  artifacts,
] as unknown as readonly AnnotatedToolFactory[];

/** Everything the definition needs that is per-deployment data. */
export interface MyraWorkflowInput {
  /** The definition id: Myra's fixed `ASSISTANT_WORKFLOW_ID`, or a created
   * agent's slug — the bundle is generic over which agent it builds. */
  readonly workflowId: string;
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** The prompt this deployment runs with. */
  readonly systemPrompt: string;
  /** The tenant credential holding this agent's hub token, minted by the
   * deployer before the source is pushed. The definition binds it to the
   * artifact tools and requires its use on the deployer's authority. */
  readonly hubCredentialId: string;
}

/**
 * Builds Myra's definition. Exactly one step, on purpose: the single-step
 * shape is what makes a deployment conversational (the execution host keeps
 * one warm agent with durable memory across runs). A second step would
 * silently trade that memory away, so the step count is contract, not style.
 *
 * The step carries no `timeout`. A step timeout is an execution budget that
 * stays armed across an approval park, so any finite value aborts a warm
 * agent that is waiting on a person to answer an ask-gated tool call.
 * `toolPackagePins` is empty because the source lineage resolves no
 * manifest: the factories above are the whole tool surface.
 */
export function buildMyraWorkflow(input: MyraWorkflowInput): WorkflowDefinition {
  if (input.workflowId === "") {
    throw new Error("buildMyraWorkflow requires a non-empty workflowId");
  }
  if (input.triggerAddress === "") {
    throw new Error("buildMyraWorkflow requires a non-empty triggerAddress");
  }
  if (input.systemPrompt === "") {
    throw new Error("buildMyraWorkflow requires a non-empty systemPrompt");
  }
  if (input.hubCredentialId === "") {
    throw new Error("buildMyraWorkflow requires a non-empty hubCredentialId");
  }
  return defineWorkflow({
    id: input.workflowId,
    trigger: { type: "mail", to: input.triggerAddress },
    credentialBindings: [artifactToolsCredentialBinding(input.workflowId)],
    grantRequirements: [artifactToolsCredentialUseRequirement(input.hubCredentialId)],
    steps: {
      assistant: step({
        agent: {
          id: ASSISTANT_STEP_ID,
          description: ASSISTANT_DESCRIPTION,
          systemPrompt: input.systemPrompt,
          toolFactories: MYRA_TOOL_FACTORIES,
          capabilities: [],
          inference: { sources: input.inferencePreferences },
          toolPackagePins: [],
        } satisfies AgentDefinition,
        triggers: "unbounded",
      }),
    },
  });
}
