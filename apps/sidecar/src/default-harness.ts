import fs from 'node:fs';
import path from 'node:path';
import { evaluateGrants } from '@intx/authz';
import { createToolRunner, createDefaultDirectorRegistry, defineTool } from '@intx/agent';
import { createHarness, createHarnessRuntimeCapabilities } from '@intx/harness';
import { readDeployTree } from '@intx/hub-agent';
import { hasProvider } from '@intx/inference';
import { getLogger } from '@intx/log';
import { createIsogitStore, createMailAuditStore } from '@intx/storage-isogit';
import { createMailTools } from '@intx/tools-mail';
import { createPosixTools } from '@intx/tools-posix';
import { createLSPPlugin } from '@intx/tools-lsp';
import { createBlobReader } from '@intx/types/runtime';
import type { InferenceSource, ToolDefinition, ToolRunner } from '@intx/types/runtime';
import type { HarnessBuilder, HarnessBundle } from '@intx/hub-agent';
import { createAskPrincipalTool } from '@workbench/approvals';
import { createHubToolRunner } from './hub-tool-runner';

const logger = getLogger(['sidecar', 'harness-builder']);

function mergeToolRunners(runners: ToolRunner[]): ToolRunner & { definitions: ToolDefinition[] } {
  const allDefinitions = runners.flatMap((r) => (r as any).definitions ?? []);
  const toolToRunner = new Map<string, ToolRunner>();
  for (const runner of runners) {
    const definitions = (runner as any).definitions ?? [];
    for (const def of definitions) {
      toolToRunner.set(def.name, runner);
    }
  }

  return {
    definitions: allDefinitions,
    async run(call, signal) {
      const runner = toolToRunner.get(call.name);
      if (!runner) {
        return {
          callId: call.id,
          content: { error: `Tool "${call.name}" is not available` },
          isError: true,
        };
      }
      return runner.run(call, signal);
    },
  };
}

export { mergeToolRunners as combineRunners };

type DefinedRunner = ToolRunner & { definitions: ToolDefinition[] };

/**
 * Derive the hub's HTTP origin from its websocket URL.
 */
export function wsUrlToHttp(wsUrl: string): string {
  const url = new URL(wsUrl);
  const protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${url.host}`;
}

/**
 * Filter a merged tool runner to only expose the tool definitions the hub
 * configured for this agent.
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

      const capabilities = createHarnessRuntimeCapabilities({ transport: agentTransport });
      const mailTools = createMailTools({ capabilities });

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
        ...mailTools.definitions.map((d) => d.name),
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

      const allTools = mergeToolRunners([
        posixTools,
        mailTools,
        askPrincipalRunner as DefinedRunner,
        hubToolRunner,
      ]);
      const allowedNames = new Set(agentConfig.tools.map((t) => t.name));
      const tools = filterToolRunner(allTools as DefinedRunner, allowedNames);

      try {
        const toolsFactory = defineTool({
          id: '@workbench/sidecar/tools',
          factory: () => ({
            definitions: tools.definitions,
            run: tools.run.bind(tools),
          }),
        });

        const def = {
          id: agentConfig.agentId,
          systemPrompt,
          toolFactories: [toolsFactory] as const,
          capabilities: [],
          inference: { sources: [] as const },
        };

        const env = {
          source,
          storage,
          workdir: workDir,
          audit: storage,
          authorize,
          directors: createDefaultDirectorRegistry(),
          transport: agentTransport,
          address: agentAddress,
          onConnectorStateChanged,
        };

        const harness = await createHarness(def, env);

        // Forward the reactor's event stream to the hub. This is the seam the
        // SessionManager builds around: it supplies `onEvent` and expects the
        // builder to invoke it for each event. Without this, the hub only ever
        // sees outbound mail — never inference/turn events — so committed turns
        // and streaming text never reach the UI live and only appear on reload.
        // `message.received` is reactor-internal and not an InferenceEvent.
        //
        // The loop ends when the harness closes its stream consumers (on
        // session teardown). A stream error (e.g. StreamBackpressureError if a
        // consumer overruns its buffer) is caught and logged rather than left to
        // reject: the disposer awaits this promise, so an unsettled rejection
        // would otherwise surface as an unhandled rejection or stall teardown.
        async function forwardEvents(): Promise<void> {
          try {
            for await (const event of harness.stream()) {
              if (event.type === 'message.received') continue;
              onEvent(event);
            }
          } catch (err) {
            logger.warn('Harness event forwarding stopped for {address}: {msg}', {
              address: agentAddress,
              msg: err instanceof Error ? err.message : String(err),
            });
          }
        }
        const eventForwarding = forwardEvents();

        return {
          harness,
          mailStore,
          updateGrants(grants) {
            grantsRef.current = grants;
          },
          disposers: [() => mailTools.dispose(), () => posixTools.dispose(), () => eventForwarding],
        };
      } catch (err) {
        try {
          await mailTools.dispose();
        } catch (disposeErr) {
          const msg = disposeErr instanceof Error ? disposeErr.message : String(disposeErr);
          logger.warn('mailTools.dispose failed during harness rollback: {msg}', { msg });
        }
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
