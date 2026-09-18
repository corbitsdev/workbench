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

import { ASSISTANT_STEP_ID, ASSISTANT_WORKFLOW_ID } from "./workflow-ids";

export { ASSISTANT_SYSTEM_PROMPT } from "./system-prompt";
export { ASSISTANT_STEP_ID, ASSISTANT_WORKFLOW_ID } from "./workflow-ids";

/** The description the agent step carries; mirrored by the JSON projection
 * the deploy writes beside the entry, so both must stay identical. */
export const ASSISTANT_DESCRIPTION =
  "A general-purpose assistant that answers questions, drafts " +
  "text, and reasons through problems for the team";

// Upstream's own tool packages, the only kind of tool Interchange has:
// mail over the agent's transport and posix over its working tree. Neither
// calls a hub API — nothing in the platform gives an agent that reach.
export const MYRA_TOOL_FACTORIES = [mail, posix] as unknown as readonly AnnotatedToolFactory[];

/** Everything the definition needs that is per-deployment data. */
export interface MyraWorkflowInput {
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
  /** The prompt this deployment runs with. */
  readonly systemPrompt: string;
}

/**
 * Builds Myra's definition. Exactly one step, on purpose: the single-step
 * shape is what makes a deployment conversational (the execution host keeps
 * one warm agent with durable memory across runs). A second step would
 * silently trade that memory away, so the step count is contract, not style.
 *
 * The step always sets an explicit `timeout` — the singular `agent:`
 * shorthand sets none, and a wedged inference call would then hang a run
 * forever. `toolPackagePins` is empty because the source lineage resolves
 * no manifest: the factories above are the whole tool surface.
 */
export function buildMyraWorkflow(input: MyraWorkflowInput): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error("buildMyraWorkflow requires a non-empty triggerAddress");
  }
  if (input.systemPrompt === "") {
    throw new Error("buildMyraWorkflow requires a non-empty systemPrompt");
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error("buildMyraWorkflow requires turnTimeoutMs to be a positive integer");
  }
  return defineWorkflow({
    id: ASSISTANT_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
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
        timeout: input.turnTimeoutMs,
        triggers: "unbounded",
      }),
    },
  });
}
