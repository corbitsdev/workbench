// The function-free projection of `buildWorkerWorkflow`, written beside the
// entry as `definition.json` for readers. Browser-safe: no `@intx/*` import,
// because `defineWorkflow` pulls in a Node-bound runtime. It mirrors that
// function's normalization (single step gets `input: trigger.payload`;
// `triggers: "unbounded"` gets `drainBehavior: "wait"`; a bare trigger becomes
// a one-element `triggers` array). Every field shared with the entry is
// derived from the same constants, so the two cannot drift.
import {
  WORKER_STEP_ID,
  artifactToolsCredentialBinding,
  artifactToolsCredentialUseRequirement,
  mcpServerCredentialBinding,
  mcpServerCredentialUseRequirement,
  mcpToolNamePattern,
  memoryToolsCredentialBinding,
  memoryToolsCredentialUseRequirement,
  type McpServerDeployment,
} from "./workflow-ids";

/** The description the agent step carries. */
export const WORKER_DESCRIPTION =
  "A co-worker that lives in one workbench: answers questions, " +
  "drafts text, and gets things done for the team";

/** Tool names the director splits on, read from the factories' own
 * declarations by the bundle build so a renamed tool cannot fall out of both
 * lists. */
export type WorkerToolNames = {
  readonly visible: readonly string[];
  readonly deferred: readonly string[];
};

/** The director's tool split: what every turn carries, and what the model has
 * to search for. A remote catalog can run to dozens of tools, so a whole
 * server's namespace stays behind one pattern. */
export function workerDirectorRef(toolNames: WorkerToolNames, mcpHandles: readonly string[]) {
  return {
    id: "@corbits/deferred-tools/director",
    config: {
      visible: [...toolNames.visible],
      deferred: [...toolNames.deferred, ...mcpHandles.map(mcpToolNamePattern)],
    },
  };
}

/** Everything the definition needs that is per-deployment data. */
export interface WorkerWorkflowInput {
  /** The definition id: the default `WORKER_WORKFLOW_ID`, or a created
   * agent's slug — the bundle is generic over which agent it builds. */
  readonly workflowId: string;
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly {
    readonly provider: string;
    readonly model: string;
    readonly parameters?: Readonly<Record<string, unknown>>;
  }[];
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

/** A non-default tool permission (`ask` is the stock default) to carry onto
 * a redeployed run. */
export type ToolEffect = {
  readonly resource: string;
  readonly effect: "allow" | "deny";
};

export function buildWorkerDefinitionJson(
  input: WorkerWorkflowInput,
  toolNames: WorkerToolNames,
  /** Re-declared as grant requirements so the new run materializes them at
   * its first trigger. */
  toolEffects: readonly ToolEffect[] = [],
): unknown {
  return {
    id: input.workflowId,
    credentialBindings: [
      artifactToolsCredentialBinding(input.workflowId),
      memoryToolsCredentialBinding(input.workflowId),
      ...input.mcpServers.map((server) => mcpServerCredentialBinding(server)),
    ],
    grantRequirements: [
      artifactToolsCredentialUseRequirement(input.hubCredentialId),
      memoryToolsCredentialUseRequirement(input.hubCredentialId),
      ...input.mcpServers.map((server) => mcpServerCredentialUseRequirement(server.credentialId)),
      ...toolEffects.map((tool) => ({
        resource: tool.resource,
        action: "invoke",
        effect: tool.effect,
        source: "creator",
      })),
    ],
    // `to` only feeds the deploy-time mail.address/mail.send grants; the agent
    // is reached at its run address, minted at deploy time.
    triggers: [{ type: "mail", to: input.triggerAddress }],
    steps: {
      [WORKER_STEP_ID]: {
        kind: "step",
        id: WORKER_STEP_ID,
        agent: {
          id: WORKER_STEP_ID,
          description: WORKER_DESCRIPTION,
          systemPrompt: input.systemPrompt,
          toolFactories: [],
          director: workerDirectorRef(
            toolNames,
            input.mcpServers.map((server) => server.handle),
          ),
          capabilities: [],
          inference: { sources: input.inferencePreferences.map((source) => ({ ...source })) },
          toolPackagePins: [],
        },
        drainBehavior: "wait",
        triggers: "unbounded",
        input: { from: "trigger.payload" },
      },
    },
    stepOrder: [WORKER_STEP_ID],
  };
}
