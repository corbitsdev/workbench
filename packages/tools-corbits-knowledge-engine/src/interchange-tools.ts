// This package cannot use `defineCredentialedToolPackage` (the shared
// firecrawl/exa/granola-style helper) verbatim: its two tools need the
// calling agent's tenantId/principalId — resolved from context, never from
// agent-supplied arguments — alongside the resolved provider credential. The
// sidecar injects the hub-RPC context (`HUB_RPC_ENV_KEY`) into every tool
// factory's env regardless of which keys it declares in `requires` (see
// `apps/sidecar/src/step-tool-harness.ts`), so this factory declares BOTH
// env keys and merges them into one config before building the tools.
import {
  type AgentTool,
  type AnnotatedToolFactory,
  createToolRunner,
  defineTool,
} from "@intx/agent";
import {
  HUB_RPC_ENV_KEY,
  getHubRpc,
  getToolCredential,
  toolCredentialEnvKey,
} from "@workbench/tool-credentials";
import { KNOWLEDGE_ENGINE_HUB_TOOLS } from "./index";

const PROVIDER_NAME = "corbits-knowledge-engine";

export const corbitsKnowledgeEngine: AnnotatedToolFactory = defineTool({
  id: "@workbench/tools-corbits-knowledge-engine/corbits-knowledge-engine",
  requires: [toolCredentialEnvKey(PROVIDER_NAME), HUB_RPC_ENV_KEY],
  factory: (env) => {
    const record = env as unknown as Record<string, unknown>;
    const credential = getToolCredential(record, PROVIDER_NAME);
    const hubRpc = getHubRpc(record);

    const byName = new Map<string, AgentTool>();
    for (const entry of Object.values(KNOWLEDGE_ENGINE_HUB_TOOLS)) {
      for (const tool of entry.createTools({
        apiKey: credential.apiKey,
        baseURL: credential.baseURL,
        tenantId: hubRpc.tenantId,
        principalId: hubRpc.principalId,
      })) {
        if (!byName.has(tool.definition.name)) {
          byName.set(tool.definition.name, tool);
        }
      }
    }
    return createToolRunner([...byName.values()]);
  },
});
