// Deploys the default worker through the one install path, `installPackage`,
// over stock routes only.
import { WORKER_SYSTEM_PROMPT } from "@corbits/worker/prompt";
import { buildWorkerDefinitionJson } from "@corbits/worker/definition-json";
import type {
  ToolEffect,
  WorkerToolNames,
  WorkerWorkflowInput,
} from "@corbits/worker/definition-json";
import { WORKER_WORKFLOW_ID } from "@corbits/worker/workflow-ids";
import { renderBundledWorkflowSourceTree } from "@corbits/workflows/client";
import { type } from "arktype";

import { ensureAgentHubCredential } from "./agent-hub-credential";
import { installPackage } from "./install-package";
import { ensureBuiltInMcpServers, toMcpServerDeployment } from "./mcp-servers";
import { WORKER_SOURCE_CONFIG } from "./worker-source";
import type { DeclaredSource } from "./onboarding/provider-connect-step";

const ToolNamesShape = type({ visible: "string[]", deferred: "string[]" });

/** Renders a worker-harness agent's source tree: the bundled entry plus the
 * one definition JSON, so a created agent and Worker cannot drift. */
export async function renderWorkerSourceTree(
  packageName: string,
  input: WorkerWorkflowInput,
  toolEffects: readonly ToolEffect[] = [],
): Promise<Record<string, string>> {
  // Half a megabyte of bundled entry text, needed only during setup — kept
  // out of the app's entry chunk the same way the git client is.
  const {
    WORKER_BUNDLE_BUILD_EXPORT,
    WORKER_DIRECTORS_BUNDLE,
    WORKER_WORKFLOW_BUNDLE,
    WORKER_TOOL_NAMES_JSON,
  } = await import("@corbits/worker/bundle");
  const toolNames: WorkerToolNames | type.errors = ToolNamesShape(
    JSON.parse(WORKER_TOOL_NAMES_JSON),
  );
  if (toolNames instanceof type.errors) {
    throw new Error(`the worker's tool names are malformed: ${toolNames.summary}`);
  }
  return renderBundledWorkflowSourceTree({
    packageName,
    bundle: WORKER_WORKFLOW_BUNDLE,
    directorsBundle: WORKER_DIRECTORS_BUNDLE,
    buildExport: WORKER_BUNDLE_BUILD_EXPORT,
    buildInput: input,
    workflowJson: JSON.stringify(buildWorkerDefinitionJson(input, toolNames, toolEffects)),
  });
}

export type DeployedWorker = Awaited<ReturnType<typeof installPackage>>;

export async function deployWorkerSource(
  args: {
    tenantId: string;
    tenantDomain: string;
    sourceOfferingIds: readonly string[];
    defaultSourceOfferingId: string;
    declaredSources: readonly DeclaredSource[];
    /** Deploy anew even when nothing changed (a restart mints a fresh run). */
    redeploy?: boolean;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<DeployedWorker> {
  // The catalogs come out of the stored credentials, so a redeploy never
  // reaches an MCP server; only adding one does.
  const mcpServers = (await ensureBuiltInMcpServers(args.tenantId, fetchImpl)).map(
    toMcpServerDeployment,
  );
  return installPackage({
    fetch: fetchImpl,
    origin: globalThis.location.origin,
    tenantId: args.tenantId,
    assetName: WORKER_SOURCE_CONFIG.assetName,
    displayName: WORKER_SOURCE_CONFIG.displayName,
    // Minted once the asset exists: the definition binds this credential by
    // name and requires its use by id, so it must precede the source.
    files: async (assetId) =>
      renderWorkerSourceTree(WORKER_SOURCE_CONFIG.packageName, {
        workflowId: WORKER_WORKFLOW_ID,
        triggerAddress: `worker@${args.tenantDomain}`,
        inferencePreferences: args.declaredSources.map((source) => ({ ...source })),
        systemPrompt: WORKER_SYSTEM_PROMPT,
        hubCredentialId: await ensureAgentHubCredential(
          { tenantId: args.tenantId, definitionId: WORKER_WORKFLOW_ID, assetId },
          fetchImpl,
        ),
        mcpServers,
      }),
    entry: WORKER_SOURCE_CONFIG.entryPath,
    sourceOfferingIds: args.sourceOfferingIds,
    defaultSourceOfferingId: args.defaultSourceOfferingId,
    ...(args.redeploy === true ? { redeploy: true } : {}),
  });
}
