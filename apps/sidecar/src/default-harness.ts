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
import { createToolRunner } from '@intx/agent';

const logger = getLogger(['sidecar', 'harness-builder']);

export function wsUrlToHttp(wsUrl: string): string {
  return wsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
}

type HarnessBuilderOpts = {
  hubHttpUrl: string;
  sidecarToken: string;
};

export function createDefaultHarnessBuilder({
  hubHttpUrl,
  sidecarToken,
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

      const tools = mergeToolRunners([
        posixTools,
        askPrincipalRunner as unknown as typeof posixTools,
      ]);

      try {
        const harness = createHarness({
          address: agentAddress,
          systemPrompt,
          source,
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
