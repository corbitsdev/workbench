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
import { memory } from "@corbits/memory/sidecar-bundle";
import { mcpServers } from "@corbits/mcp/sidecar-bundle";
import { toolSearch } from "@corbits/deferred-tools";

import {
  ASSISTANT_STEP_ID,
  artifactToolsCredentialBinding,
  artifactToolsCredentialUseRequirement,
  mcpServerCredentialBinding,
  mcpServerCredentialUseRequirement,
  mcpToolNamePattern,
  memoryToolsCredentialBinding,
  memoryToolsCredentialUseRequirement,
  type McpServerDeployment,
} from "./workflow-ids";

export { ASSISTANT_SYSTEM_PROMPT } from "./system-prompt";
export { ASSISTANT_STEP_ID, ASSISTANT_WORKFLOW_ID } from "./workflow-ids";

/** The description the agent step carries; mirrored by the JSON projection
 * the deploy writes beside the entry, so both must stay identical. */
export const ASSISTANT_DESCRIPTION =
  "A general-purpose assistant that answers questions, drafts " +
  "text, and reasons through problems for the team";

// Tool packages in the shape Interchange has: mail over the agent's
// transport, posix over its working tree, and artifacts and memory through
// the hub credential the deploy binds — the agent itself holds no client
// code and no secret.
export const MYRA_TOOL_FACTORIES = [
  mail,
  posix,
  artifacts,
  memory,
  toolSearch,
] as unknown as readonly AnnotatedToolFactory[];

/** The director's tool split, derived from the factories' own declarations so
 * a renamed tool can never fall out of both lists: mail and posix are what
 * every turn carries, artifacts and memory are what the model has to search
 * for. */
function toolNames(factories: readonly AnnotatedToolFactory[]): string[] {
  return factories.flatMap((factory) => factory.definitions.map((definition) => definition.name));
}

export function myraDirector(mcpHandles: readonly string[]) {
  return {
    id: "@corbits/deferred-tools/director",
    config: {
      visible: toolNames([mail, posix] as unknown as readonly AnnotatedToolFactory[]),
      deferred: [
        ...toolNames([artifacts, memory] as unknown as readonly AnnotatedToolFactory[]),
        // A remote catalog can run to dozens of tools, so a whole server's
        // namespace stays behind one pattern until the model searches for it.
        ...mcpHandles.map(mcpToolNamePattern),
      ],
    },
  };
}

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
   * artifact and memory tools and requires its use on the deployer's
   * authority. */
  readonly hubCredentialId: string;
  /** The MCP servers this deployment carries, catalogs already discovered.
   * Each one gets its own credential handle, binding and use requirement. */
  readonly mcpServers: readonly McpServerDeployment[];
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
      assistant: step({
        agent: {
          id: ASSISTANT_STEP_ID,
          description: ASSISTANT_DESCRIPTION,
          systemPrompt: input.systemPrompt,
          toolFactories: [
            ...MYRA_TOOL_FACTORIES,
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
          director: myraDirector(input.mcpServers.map((server) => server.handle)),
          capabilities: [],
          inference: { sources: input.inferencePreferences },
          toolPackagePins: [],
        } satisfies AgentDefinition,
        triggers: "unbounded",
      }),
    },
  });
}
