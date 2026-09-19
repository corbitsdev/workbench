// No stock file-read route exists for a workflow asset (only
// package-registry tarballs get one), so this fetches `main` over the
// asset's smart-HTTP git remote with a short-lived read-only token.
import {
  parseWorkflowSourceDefinition,
  WORKFLOW_SOURCE_DEFINITION_PATH,
} from "@corbits/workflows/client";
import { MCP_TOOLS_PACKAGE } from "@corbits/myra/workflow-ids";
import { type } from "arktype";

import { fetchSourceFile } from "./git-fetch";
import { withGitToken } from "./git-token";

export class AgentSourceReadError extends Error {}

const ToolPackagePinShape = type({ name: "string", version: "string" });

const CredentialBindingShape = type({
  package: "string",
  handle: "string",
});

const AgentWorkflowJsonShape = type({
  id: "string",
  "credentialBindings?": CredentialBindingShape.array(),
  steps: type.Record(
    "string",
    type({
      agent: type({
        systemPrompt: "string",
        inference: { sources: type({ provider: "string", model: "string" }).array() },
        "toolPackagePins?": ToolPackagePinShape.array(),
      }),
    }),
  ),
});

const READ_TOKEN_LIFETIME_MS = 10 * 60 * 1000;

/** An existing agent's deploy source, in the shape `deployAgentSource`'s
 * `NewAgentInput` needs plus the sources it declares for inference. */
export type AgentSource = {
  readonly systemPrompt: string;
  readonly declaredSources: readonly { readonly provider: string; readonly model: string }[];
};

export type AgentToolPackagePin = { readonly name: string; readonly version: string };

type AgentWorkflowJson = typeof AgentWorkflowJsonShape.infer;
type AgentWorkflowStep = AgentWorkflowJson["steps"][string];

// Each reader mints and revokes its own short-lived token rather than
// holding one open across a batch of assets.
async function readAgentWorkflowStep(
  tenantId: string,
  assetId: string,
  assetName: string,
  fetchImpl: typeof fetch,
): Promise<AgentWorkflowJson> {
  const url = new URL(
    `/api/tenants/${encodeURIComponent(tenantId)}/assets/workflow/${assetName}.git`,
    globalThis.location.origin,
  ).toString();
  return withGitToken({
    tenantId,
    assetId,
    actions: ["can_read"],
    lifetimeMs: READ_TOKEN_LIFETIME_MS,
    fetchImpl,
    use: async (token) => {
      const definitionFile = await fetchSourceFile({
        url,
        token,
        filepath: WORKFLOW_SOURCE_DEFINITION_PATH,
      });
      const workflowJson = parseWorkflowSourceDefinition(definitionFile, assetId);
      const parsed = AgentWorkflowJsonShape(JSON.parse(workflowJson));
      if (parsed instanceof type.errors) {
        throw new AgentSourceReadError(
          `this agent's source came back an unexpected shape: ${parsed.summary}`,
        );
      }
      if (Object.values(parsed.steps).length === 0) {
        throw new AgentSourceReadError("this agent's source has no steps to read a prompt from");
      }
      return parsed;
    },
  });
}

/** The one step every agent this client deploys carries. */
function onlyStep(definition: AgentWorkflowJson): AgentWorkflowStep {
  const step = Object.values(definition.steps)[0];
  if (step === undefined) {
    throw new AgentSourceReadError("this agent's source has no steps to read a prompt from");
  }
  return step;
}

/** Mints a read-only token, fetches the asset's `main`, and parses out the
 * agent definition its source tree carries. */
export async function readAgentSource(
  tenantId: string,
  assetId: string,
  assetName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentSource> {
  const step = onlyStep(await readAgentWorkflowStep(tenantId, assetId, assetName, fetchImpl));
  return {
    systemPrompt: step.agent.systemPrompt,
    declaredSources: step.agent.inference.sources,
  };
}

/** Empty for an agent whose tools ride bundled into its `workflow.js`
 * closure instead — see `deployed-tool-packages.ts`'s `MYRA_TOOL_PACKAGES`. */
export async function readAgentToolPackagePins(
  tenantId: string,
  assetId: string,
  assetName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly AgentToolPackagePin[]> {
  const step = onlyStep(await readAgentWorkflowStep(tenantId, assetId, assetName, fetchImpl));
  return step.agent.toolPackagePins ?? [];
}

/** The MCP server handles an agent's deployed definition binds, which is what
 * makes it the carrier of that server rather than the workbench's tenant. */
export async function readAgentMcpHandles(
  tenantId: string,
  assetId: string,
  assetName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly string[]> {
  const definition = await readAgentWorkflowStep(tenantId, assetId, assetName, fetchImpl);
  return (definition.credentialBindings ?? [])
    .filter((binding) => binding.package === MCP_TOOLS_PACKAGE)
    .map((binding) => binding.handle);
}
