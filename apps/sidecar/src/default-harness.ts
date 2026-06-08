import fs from 'node:fs';
import path from 'node:path';
import { evaluateGrants } from '@intx/authz';
import {
  createDefaultDirectorRegistry,
  createToolRunner,
  defineAgent,
  defineTool,
  fromToolRunner,
} from '@intx/agent';
import type { MailEnv } from '@intx/harness';
import { createHarness } from '@intx/harness';
import { hasProvider } from '@intx/inference';
import { getLogger } from '@intx/log';
import { createIsogitStore, createMailAuditStore } from '@intx/storage-isogit';
import { createPosixTools } from '@intx/tools-posix';
import { createLSPPlugin } from '@intx/tools-lsp';
import { createBlobReader } from '@intx/types/runtime';
import type { InferenceEvent, InferenceSource } from '@intx/types/runtime';
import { readDeployTree, type HarnessBuilder, type HarnessBundle } from '@intx/hub-agent';
import { createAskPrincipalTool } from '@workbench/approvals';
import { decryptSecret, type CredentialKeyRegistry } from '@workbench/hub-crypto';
import { createHubToolRunner } from './hub-tool-runner';
import type { ToolDefinition, ToolRunner } from '@intx/types/runtime';

const logger = getLogger(['sidecar', 'harness-builder']);

type DefinedRunner = ToolRunner & { definitions: readonly ToolDefinition[] };

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
 * Combine several tool runners into a single runner that dispatches each
 * call to the runner that owns the named tool. Replaces the removed
 * `@intx/harness` `mergeToolRunners` helper: the new runtime composes
 * tools through `defineAgent({ tools: [...] })` factories, but the
 * sidecar still wants a single dispatchable runner so it can gate the
 * model-visible surface (see `filterToolRunner`) before handing the
 * result to the agent as one bundle.
 */
export function combineRunners(runners: DefinedRunner[]): DefinedRunner {
  const byName = new Map<string, DefinedRunner>();
  const definitions: ToolDefinition[] = [];
  for (const runner of runners) {
    for (const def of runner.definitions) {
      byName.set(def.name, runner);
      definitions.push(def);
    }
  }
  return {
    definitions,
    async run(call, signal) {
      const runner = byName.get(call.name);
      if (runner === undefined) {
        return {
          callId: call.id,
          content: { error: `Tool "${call.name}" has no registered handler` },
          isError: true,
        };
      }
      return runner.run(call, signal);
    },
  };
}

/**
 * Filter a merged tool runner to only expose the tool definitions the hub
 * configured for this agent. The underlying handlers remain available so
 * that the sidecar can safely add new tools without the hub needing to
 * know about them at launch time; only the model-visible definitions are
 * gated.
 */
function filterToolRunner(runner: DefinedRunner, allowedNames: Set<string>): DefinedRunner {
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

      const localToolNames = new Set([
        ...posixTools.definitions.map((d) => d.name),
        ...askPrincipalRunner.definitions.map((d) => d.name),
      ]);

      const hubToolRunner = createHubToolRunner({
        hubHttpUrl,
        sidecarToken,
        tenantId,
        agentId: agentConfig.agentId,
        principalId,
        sessionId: agentConfig.sessionId,
        toolDefinitions: agentConfig.tools.filter((t) => !localToolNames.has(t.name)),
      });

      const allTools = combineRunners([posixTools, askPrincipalRunner, hubToolRunner]);
      const allowedNames = new Set(agentConfig.tools.map((t) => t.name));
      const tools = filterToolRunner(allTools, allowedNames);

      // The new runtime composes tools through `defineAgent` factories. We
      // already have one fully-assembled, name-gated runner, so wrap it in
      // a single `defineTool` bundle that adapts the runner's definitions
      // and dispatch into the agent's factory contract.
      const toolFactory = defineTool({
        id: '@workbench/sidecar/tools',
        factory: () => {
          const adapted = createToolRunner(fromToolRunner(tools));
          return {
            definitions: adapted.definitions,
            run: (call, signal) => adapted.run(call, signal),
          };
        },
      });

      const definition = defineAgent({
        id: agentConfig.agentId,
        systemPrompt,
        tools: [toolFactory],
        capabilities: [],
        inference: { sources: [{ provider: source.provider, model: source.model }] },
      });

      const decryptedSource = decryptSource(source, credentialKeys, tenantId);

      const env: MailEnv = {
        source: decryptedSource,
        storage,
        workdir: workDir,
        audit: storage,
        authorize,
        directors: createDefaultDirectorRegistry(),
        transport: agentTransport,
        address: agentAddress,
        onConnectorStateChanged,
      };

      try {
        const harness = await createHarness(definition, env);

        // The old harness accepted an `onEvent` callback directly; the new
        // runtime exposes events only through `harness.stream()`. Subscribe
        // and forward every reactor event except `message.received` (which
        // is not part of the `InferenceEvent` union the session sink
        // consumes). The drain is detached and stops when the stream closes
        // on `harness.close()`; the disposer guards against double-stop.
        let stopForwarding = false;
        async function forwardEvents(): Promise<void> {
          try {
            for await (const event of harness.stream()) {
              if (stopForwarding) break;
              if (event.type === 'message.received') continue;
              onEvent(event as InferenceEvent);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('event-forwarding stream terminated: {msg}', { msg });
          }
        }
        const forwardingDone = forwardEvents();

        return {
          harness,
          mailStore,
          updateGrants(grants) {
            grantsRef.current = grants;
          },
          disposers: [
            async () => {
              stopForwarding = true;
              await forwardingDone;
            },
            () => posixTools.dispose(),
          ],
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
