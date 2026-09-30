// The worker's workflow entry: a single-step, mail-triggered conversational
// definition whose agent carries its tool factories inline.
//
// This module is never imported by a browser bundle. It is the entrypoint
// `scripts/build-bundle.ts` bundles into one self-contained ESM file that
// the deploy pushes as the asset's `workflow.js`; the sidecar's
// source-deploy path evaluates that closure and runs `req.agent.toolFactories`
// directly, so the factories must be real functions here rather than
// `toolPackagePins` the source lineage never resolves.

import type { AgentDefinition, AnnotatedToolFactory } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import { mail } from "@intx/tools-mail/sidecar-bundle";
import { posix } from "@intx/tools-posix/sidecar-bundle";
import { artifacts } from "@corbits/artifacts/sidecar-bundle";
import { memory } from "@corbits/memory/sidecar-bundle";
import { mcpServers } from "@corbits/mcp/sidecar-bundle";
import { toolSearch } from "@corbits/deferred-tools";

import {
  WORKER_DESCRIPTION,
  workerDirectorRef,
  type WorkerToolNames,
  type WorkerWorkflowInput,
} from "./definition-json";
import {
  WORKER_STEP_ID,
  artifactToolsCredentialBinding,
  artifactToolsCredentialUseRequirement,
  mcpServerCredentialBinding,
  mcpServerCredentialUseRequirement,
  memoryToolsCredentialBinding,
  memoryToolsCredentialUseRequirement,
} from "./workflow-ids";

export { WORKER_SYSTEM_PROMPT } from "./system-prompt";
export { WORKER_STEP_ID, WORKER_WORKFLOW_ID } from "./workflow-ids";
export { WORKER_DESCRIPTION, type WorkerWorkflowInput } from "./definition-json";

// Tool packages in the shape Interchange has: mail over the agent's
// transport, posix over its working tree, and artifacts and memory through
// the hub credential the deploy binds — the agent itself holds no client
// code and no secret.
export const WORKER_TOOL_FACTORIES = [
  mail,
  posix,
  artifacts,
  memory,
  toolSearch,
] as unknown as readonly AnnotatedToolFactory[];

function toolNames(factories: readonly AnnotatedToolFactory[]): string[] {
  return factories.flatMap((factory) => factory.definitions.map((definition) => definition.name));
}

/** Read from the factories' own declarations: mail and posix are what every
 * turn carries, artifacts and memory are what the model has to search for.
 * The bundle build writes this beside the bundle for the browser-safe JSON. */
export const WORKER_TOOL_NAMES: WorkerToolNames = {
  visible: toolNames([mail, posix] as unknown as readonly AnnotatedToolFactory[]),
  deferred: toolNames([artifacts, memory] as unknown as readonly AnnotatedToolFactory[]),
};

/**
 * Builds the worker's definition. Exactly one step, on purpose: the single-step
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
export function buildWorkerWorkflow(input: WorkerWorkflowInput): WorkflowDefinition {
  if (input.workflowId === "") {
    throw new Error("buildWorkerWorkflow requires a non-empty workflowId");
  }
  if (input.triggerAddress === "") {
    throw new Error("buildWorkerWorkflow requires a non-empty triggerAddress");
  }
  if (input.systemPrompt === "") {
    throw new Error("buildWorkerWorkflow requires a non-empty systemPrompt");
  }
  if (input.hubCredentialId === "") {
    throw new Error("buildWorkerWorkflow requires a non-empty hubCredentialId");
  }
  return defineWorkflow({
    id: input.workflowId,
    trigger: { type: "mail", to: input.triggerAddress },
    credentialBindings: [
      artifactToolsCredentialBinding(input.workflowId),
      memoryToolsCredentialBinding(input.workflowId),
      ...input.mcpServers.map((server) => mcpServerCredentialBinding(server)),
    ],
    grantRequirements: [
      artifactToolsCredentialUseRequirement(input.hubCredentialId),
      memoryToolsCredentialUseRequirement(input.hubCredentialId),
      ...input.mcpServers.map((server) => mcpServerCredentialUseRequirement(server.credentialId)),
    ],
    steps: {
      worker: step({
        agent: {
          id: WORKER_STEP_ID,
          description: WORKER_DESCRIPTION,
          systemPrompt: input.systemPrompt,
          toolFactories: [
            ...WORKER_TOOL_FACTORIES,
            // Built per deployment: the factory is configured with the stored
            // catalogs, so construction stays synchronous and offline.
            mcpServers({
              servers: input.mcpServers.map((server) => ({
                handle: server.handle,
                url: server.url,
                tools: [...server.tools],
                ...(server.allowWithoutAsk !== undefined
                  ? { allowWithoutAsk: [...server.allowWithoutAsk] }
                  : {}),
              })),
            }) as unknown as AnnotatedToolFactory,
          ],
          director: workerDirectorRef(
            WORKER_TOOL_NAMES,
            input.mcpServers.map((server) => server.handle),
          ),
          capabilities: [],
          inference: { sources: input.inferencePreferences },
          toolPackagePins: [],
        } satisfies AgentDefinition,
        triggers: "unbounded",
      }),
    },
  });
}
