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
import { hasSeedMarker, parseSeedMarker, stripSeedMarker } from '@workbench/agents/seed';
import { PERSONAL_AGENT_NAME } from '@workbench/agents';
import { createAskPrincipalTool } from '@workbench/approvals';
import { seedWorkspaceFiles } from './seed-workspace-files';
import { healTurns } from '@workbench/context-repair';
import { withActiveContext } from '@workbench/prompts';
import { createGuardedMailRunner } from './mail-guard';
import type { ContextStore } from '@intx/types/runtime';
import { createHubToolRunner } from './hub-tool-runner';

const logger = getLogger(['sidecar', 'harness-builder']);
const DEFAULT_MAIL_OUTBOUND_PER_TURN = 8;
const PERSONAL_AGENT_MAIL_OUTBOUND_PER_TURN = 100;

/**
 * Repair the durable context before the harness loads it so an
 * OpenAI-compatible provider does not reject it. Two failure modes are healed:
 * null-body assistant turns ("content or tool_calls must be set") and orphaned
 * tool_calls ("'tool_calls' must be followed by tool messages"). Both poison
 * every replay until removed — ending and relaunching the session alone does
 * not clear them, because the isogit store is reused.
 */
export async function healContextStore(storage: ContextStore, agentAddress: string): Promise<void> {
  const { turns } = await storage.load();
  const healed = healTurns(turns);
  if (!healed.changed) return;

  await storage.writeTurns(healed.turns);
  await storage.commit({ message: 'recover: heal unsendable turns and tool_call pairing' });
  logger.warn(
    'Healed context for {address}: removed {removed} unsendable turn(s), synthesized {synth} tool result(s), dropped {dangling} dangling result(s)',
    {
      address: agentAddress,
      removed: healed.unsendableRemoved,
      synth: healed.toolResultsSynthesized,
      dangling: healed.danglingResultsDropped,
    }
  );
}

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

export function resolveMailOutboundLimit(systemPrompt: string): number {
  if (systemPrompt.includes(`${PERSONAL_AGENT_NAME} is a Chief of Staff and Executive Assistant`)) {
    return PERSONAL_AGENT_MAIL_OUTBOUND_PER_TURN;
  }
  return DEFAULT_MAIL_OUTBOUND_PER_TURN;
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
      await healContextStore(storage, agentAddress);
      const mailStore = await createMailAuditStore(storeDir, signer);

      const deployTree = await readDeployTree(storeDir);
      const basePrompt = deployTree.systemPrompt ?? agentConfig.systemPrompt;

      // Parse the memory-seed file list off the RAW base prompt, then strip the
      // marker before the prompt reaches the model. The marker is a
      // control-plane sentinel for the harness; the live model must never see
      // its own seed instructions (it would surface as raw text the agent could
      // echo or be confused by) — CL-1952.
      const declaredSeedFiles = parseSeedMarker(basePrompt);
      const cleanedPrompt = stripSeedMarker(basePrompt);

      // Append the unified active-context block at launch so every agent shares
      // the same runtime context and is not anchored to its training cutoff
      // (CL-1938). The human user's name is not resolvable at this seam — the
      // agentConfig principal is the synthetic per-instance principal — so only
      // the live date is populated until user identity is threaded through the
      // launch config.
      const systemPrompt = withActiveContext(cleanedPrompt, { now: new Date() });

      const grantsRef = { current: agentConfig.grants };
      const { principalId, tenantId } = agentConfig;
      const authorize = async (resource: string, action: string) =>
        evaluateGrants(grantsRef.current, resource, action, { principalId, tenantId });

      const workDir = path.join(storeDir, 'workspace');
      await fs.promises.mkdir(workDir, { recursive: true });

      // Seed the memory files the agent documents but does not create itself, so
      // its first read never fails (CL-1952). Marker presence IS the signal: a
      // prompt with no marker is simply a non-marker-bearing agent (normal), so
      // there is no phrase-based heuristic to guess "should have been seeded".
      if (declaredSeedFiles.length === 0 && hasSeedMarker(basePrompt)) {
        // A marker that resolves zero files is a malformed/empty marker — a
        // contract break between the prompt builder and the seed table. Surface
        // it rather than silently seed nothing (CL-1952).
        logger.warn('Seed marker for {address} resolved zero files (malformed)', {
          address: agentAddress,
        });
      }
      const seedResult = await seedWorkspaceFiles(workDir, declaredSeedFiles);
      logger.info('Seeded {created} workspace file(s) for {address}, skipped {skipped} existing', {
        address: agentAddress,
        created: seedResult.created,
        skipped: seedResult.skipped,
      });

      const blobReader = createBlobReader(storage);
      const posixTools = createPosixTools({
        cwd: workDir,
        plugins: [createLSPPlugin({ cwd: workDir })],
        blobReader,
      });

      const capabilities = createHarnessRuntimeCapabilities({ transport: agentTransport });
      const mailTools = createMailTools({ capabilities });
      const guardedMailTools = createGuardedMailRunner(mailTools as DefinedRunner, {
        maxOutboundPerTurn: resolveMailOutboundLimit(cleanedPrompt),
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
        guardedMailTools,
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
              if (event.type === 'message.received') {
                guardedMailTools.resetOutboundBudget();
                continue;
              }
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
