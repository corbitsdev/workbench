import fs from 'node:fs';
import path from 'node:path';
import { evaluateGrants } from '@intx/authz';
import { createHarness, readDeployTree, mergeToolRunners } from '@intx/harness';
import { hasProvider } from '@intx/inference';
import { getLogger } from '@intx/log';
import { createIsogitStore, createMailAuditStore } from '@intx/storage-isogit';
import { createPosixTools } from '@intx/tools-posix';
import { createLSPPlugin } from '@intx/tools-lsp';
import { createBlobReader } from '@intx/types/runtime';
import type { InferenceSource } from '@intx/types/runtime';
import type { HarnessBuilder, HarnessBundle } from '@intx/hub-agent';
import { createAskPrincipalTool } from '@workbench/approvals';
import { decryptSecret, type CredentialKeyRegistry } from '@workbench/hub-crypto';
import { createToolRunner } from '@intx/agent';
import { createHubToolRunner } from './hub-tool-runner';
import type { ToolDefinition, ToolRunner } from '@intx/types/runtime';

const logger = getLogger(['sidecar', 'harness-builder']);

/**
 * Derive the hub's HTTP origin from its websocket URL. Returns origin only —
 * HUB_WS_URL carries the sidecar websocket path (e.g. /api/sidecars/ws), which
 * must not leak into HTTP endpoint URLs the sidecar builds (e.g. the internal
 * tool-run endpoint mounted at /api/internal/tools/run).
 */
export function wsUrlToHttp(wsUrl: string): string {
  const url = new URL(wsUrl);
  const protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${url.host}`;
}

/**
 * Filter a merged tool runner to only expose the tool definitions the hub
 * configured for this agent. The underlying handlers remain available so
 * that the sidecar can safely add new tools without the hub needing to
 * know about them at launch time; only the model-visible definitions are
 * gated.
 */
function filterToolRunner(
  runner: ToolRunner & { definitions: ToolDefinition[] },
  allowedNames: Set<string>
): ToolRunner & { definitions: ToolDefinition[] } {
  const filtered = runner.definitions.filter((d) => allowedNames.has(d.name));
  return {
    definitions: filtered,
    async run(call, signal) {
      if (!allowedNames.has(call.name)) {
        return {
          callId: call.id,
          content: { error: `Tool "${call.name}" is not enabled for this agent` },
          isError: true,
        };
      }
      return runner.run(call, signal);
    },
  };
}

function decryptSource(
  source: InferenceSource,
  keys: CredentialKeyRegistry,
  tenantId: string
): InferenceSource {
  if (!source.apiKey?.startsWith('enc:')) return source;
  return { ...source, apiKey: decryptSecret(keys, tenantId, source.apiKey) };
}

type HarnessBuilderOpts = {
  hubHttpUrl: string;
  sidecarToken: string;
  credentialKeys: CredentialKeyRegistry;
};

export function createDefaultHarnessBuilder({
  hubHttpUrl,
  sidecarToken,
  credentialKeys,
}: HarnessBuilderOpts): HarnessBuilder {
  return {
    canBuildSource(source: InferenceSource): void {
      if (!hasProvider(source.provider)) {
        throw new Error(`Source provider "${source.provider}" is not registered`);
      }
    },

    async build({
      agentAddress,
      agentConfig,
      source,
      storeDir,
      agentTransport,
      crypto,
      onEvent,
      onConnectorStateChanged,
    }): Promise<HarnessBundle> {
      const signer = (payload: string) => crypto.signSSH(payload);

      const storage = await createIsogitStore(storeDir, signer);
      const mailStore = await createMailAuditStore(storeDir, signer);

      const deployTree = await readDeployTree(storeDir);
      const systemPrompt = deployTree.systemPrompt ?? agentConfig.systemPrompt;

      const grantsRef = { current: agentConfig.grants };
      const { principalId, tenantId } = agentConfig;
      const authorize = async (resource: string, action: string) =>
        evaluateGrants(grantsRef.current, resource, action, { principalId, tenantId });

      const workDir = path.join(storeDir, 'workspace');
      await fs.promises.mkdir(workDir, { recursive: true });

      const blobReader = createBlobReader(storage);
      const posixTools = createPosixTools({
        cwd: workDir,
        plugins: [createLSPPlugin({ cwd: workDir })],
        blobReader,
      });

      const askPrincipalRunner = createToolRunner([
        createAskPrincipalTool({
          hubHttpUrl,
          sidecarToken,
          tenantId,
          agentId: agentConfig.agentId,
          principalId,
        }),
      ]);

      const hubToolRunner = createHubToolRunner({
        hubHttpUrl,
        sidecarToken,
        tenantId,
        toolDefinitions: agentConfig.tools,
      });

      const runners: (ToolRunner & { definitions: ToolDefinition[] })[] = [
        posixTools,
        askPrincipalRunner as unknown as ToolRunner & { definitions: ToolDefinition[] },
        hubToolRunner,
      ];

      const allTools = mergeToolRunners(runners);
      const allowedNames = new Set(agentConfig.tools.map((t) => t.name));
      const tools = filterToolRunner(allTools, allowedNames);

      const decryptedSource = decryptSource(source, credentialKeys, tenantId);

      try {
        const harness = createHarness({
          address: agentAddress,
          systemPrompt,
          source: decryptedSource,
          transport: agentTransport,
          crypto,
          storage,
          authorize,
          auditStore: storage,
          tools,
          onEvent,
          onConnectorStateChanged,
        });

        return {
          harness,
          mailStore,
          updateGrants(grants) {
            grantsRef.current = grants;
          },
          disposers: [() => posixTools.dispose()],
        };
      } catch (err) {
        try {
          await posixTools.dispose();
        } catch (disposeErr) {
          const msg = disposeErr instanceof Error ? disposeErr.message : String(disposeErr);
          logger.warn('posixTools.dispose failed during harness rollback: {msg}', { msg });
        }
        throw err;
      }
    },
  };
}
