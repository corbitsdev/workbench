import fs from 'node:fs';
import path from 'node:path';
import { type } from 'arktype';
import { evaluateGrants } from '@intx/authz';
import { createToolRunner, defineTool } from '@intx/agent';
import { createWorkbenchDirectorRegistry } from '@workbench/agents';
import { createTarballCache, createToolLoader } from '@intx/tool-packaging';
import { ToolPackageManifest } from '@intx/types/tool-packages';
import {
  HUB_RPC_ENV_KEY,
  ToolCredentialsResponse,
  providerFromEnvKey,
  toolCredentialEnvKey,
} from '@workbench/tool-credentials';
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

// Materialize the agent's pinned tool packages via the tool-packaging
// loader. Fail-HARD: there is no hub-side tool proxy to fall back to, so a
// manifest that the hub wrote but the sidecar cannot parse, validate, or
// load is a genuine integrity fault — it fails the launch loudly rather
// than silently dropping the agent's tools. No manifest (no pins) is the
// only soft case: the agent simply has local tools only.
async function loadToolPackages(args: {
  rawManifestBytes: string | undefined;
  assetMounts: ReadonlyMap<string, string>;
  storeDir: string;
  agentAddress: string;
  cacheRoot: string;
  cacheMaxBytes: number;
  registryMaxTarballBytes: number;
}): Promise<Awaited<ReturnType<ReturnType<typeof createToolLoader>['loadManifest']>>> {
  if (args.rawManifestBytes === undefined) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(args.rawManifestBytes);
  } catch (err) {
    throw new Error(
      `tool-package manifest for ${args.agentAddress} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const validated = ToolPackageManifest(parsed);
  if (validated instanceof type.errors) {
    throw new Error(
      `tool-package manifest for ${args.agentAddress} failed validation: ${validated.summary}`
    );
  }

  const cache = createTarballCache({ rootDir: args.cacheRoot, maxBytes: args.cacheMaxBytes });
  const loader = createToolLoader({
    cache,
    // Our tarballs are self-contained and asset-sourced, so no HTTP
    // registry is consulted; asset entries resolve via assetMounts.
    registries: new Map(),
    host: { os: process.platform, cpu: process.arch },
    maxRegistryTarballBytes: args.registryMaxTarballBytes,
  });
  const scratchDir = path.join(args.storeDir, 'tool-packages');
  await fs.promises.mkdir(scratchDir, { recursive: true });
  return loader.loadManifest({
    manifest: validated,
    instanceScratchDir: scratchDir,
    assetRoot: path.join(args.storeDir, 'workspace'),
    assetMounts: args.assetMounts,
  });
}

// Resolve provider credentials for in-sidecar tool packages over the hub's
// authenticated channel, returned as env entries keyed by
// `toolCredentialEnvKey(provider)`. Fail-soft: errors omit the entries.
export async function fetchToolCredentials(args: {
  hubHttpUrl: string;
  sidecarToken: string;
  tenantId: string;
  agentId: string;
  providerNames: readonly string[];
  agentAddress: string;
}): Promise<Record<string, { apiKey: string; baseURL: string }>> {
  if (args.providerNames.length === 0) return {};
  let response: Response;
  try {
    response = await fetch(`${args.hubHttpUrl}/api/internal/tools/credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.sidecarToken}`,
      },
      body: JSON.stringify({
        tenantId: args.tenantId,
        agentId: args.agentId,
        providerNames: [...args.providerNames],
      }),
    });
  } catch (err) {
    logger.warn('Tool-credential fetch failed for {address}: {msg}', {
      address: args.agentAddress,
      msg: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
  if (!response.ok) {
    logger.warn('Tool-credential fetch for {address} returned {status}', {
      address: args.agentAddress,
      status: response.status,
    });
    return {};
  }
  const parsed = ToolCredentialsResponse(await response.json());
  if (parsed instanceof type.errors) {
    logger.warn('Tool-credential response for {address} failed validation: {summary}', {
      address: args.agentAddress,
      summary: parsed.summary,
    });
    return {};
  }
  const entries: Record<string, { apiKey: string; baseURL: string }> = {};
  for (const [provider, credential] of Object.entries(parsed.credentials)) {
    entries[toolCredentialEnvKey(provider)] = credential;
  }
  return entries;
}

type HarnessBuilderOpts = {
  hubHttpUrl: string;
  sidecarToken: string;
  cacheRoot: string;
  cacheMaxBytes: number;
  registryMaxTarballBytes: number;
};

export function createDefaultHarnessBuilder({
  hubHttpUrl,
  sidecarToken,
  cacheRoot,
  cacheMaxBytes,
  registryMaxTarballBytes,
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
      sources,
      defaultSource,
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

      // Materialize the agent's pinned tool packages, then resolve the
      // credentials they declare via `requires: [workbench.cred.<provider>]`
      // and inject them into env before instantiating each factory. A
      // factory that throws is skipped (fail-soft); only the names that
      // actually load are shadowed away from the proxy.
      const loadedPackages = await loadToolPackages({
        rawManifestBytes: deployTree.toolPackageManifestRaw,
        assetMounts: deployTree.assetMounts,
        storeDir,
        agentAddress,
        cacheRoot,
        cacheMaxBytes,
        registryMaxTarballBytes,
      });

      const requiredProviders = new Set<string>();
      for (const pkg of loadedPackages) {
        for (const factory of pkg.factories) {
          for (const key of factory.requires) {
            const provider = providerFromEnvKey(key);
            if (provider !== undefined) requiredProviders.add(provider);
          }
        }
      }
      const credentialEnv = await fetchToolCredentials({
        hubHttpUrl,
        sidecarToken,
        tenantId,
        agentId: agentConfig.agentId,
        providerNames: [...requiredProviders],
        agentAddress,
      });

      // Hub-RPC context for hub-backed native tool packages (artifact,
      // agents, dispatch). Their factory declares `requires: [HUB_RPC_ENV_KEY]`
      // and forwards each call to the hub's scoped endpoint with this identity.
      const hubRpcContext = {
        baseURL: hubHttpUrl,
        token: sidecarToken,
        tenantId,
        agentId: agentConfig.agentId,
        principalId,
        sessionId: agentConfig.sessionId,
      };

      const env = {
        sources,
        defaultSource,
        storage,
        workdir: workDir,
        audit: storage,
        authorize,
        directors: createWorkbenchDirectorRegistry(),
        transport: agentTransport,
        address: agentAddress,
        onConnectorStateChanged,
        ...credentialEnv,
        [HUB_RPC_ENV_KEY]: hubRpcContext,
      };

      const loadedRunners: DefinedRunner[] = [];
      const loadedDisposers: Array<() => Promise<void>> = [];
      const loadedToolNames = new Set<string>();
      for (const pkg of loadedPackages) {
        for (const factory of pkg.factories) {
          // Fail-soft per-package: construction depends on runtime resources
          // (e.g. a credential the hub fetched fail-soft — fetchToolCredentials
          // returns {} on a transient blip), so a throw here drops THIS
          // package's tools and logs, rather than bricking the whole agent
          // launch (including its local tools + inference). Manifest integrity
          // is the hard gate — that lives in loadToolPackages, not here.
          let bundle: ReturnType<typeof factory>;
          try {
            bundle = factory(env);
          } catch (err) {
            logger.warn('Tool-package factory {id} failed to construct for {address}: {msg}', {
              id: factory.id,
              address: agentAddress,
              msg: err instanceof Error ? err.message : String(err),
            });
            continue;
          }
          loadedRunners.push({
            definitions: [...bundle.definitions],
            run: (call, signal) => bundle.run(call, signal),
          });
          for (const def of bundle.definitions) loadedToolNames.add(def.name);
          if (bundle.dispose !== undefined) {
            loadedDisposers.push(async () => {
              await bundle.dispose?.();
            });
          }
        }
      }
      if (loadedToolNames.size > 0) {
        logger.info('Loaded {count} native tool(s) for {address}: {names}', {
          count: loadedToolNames.size,
          address: agentAddress,
          names: [...loadedToolNames].join(', '),
        });
      }

      // Agent tools come from local runners (posix/mail/ask-principal) plus
      // the materialized native packages — there is no hub-side tool proxy.
      const allTools = mergeToolRunners([
        posixTools,
        guardedMailTools,
        askPrincipalRunner as DefinedRunner,
        ...loadedRunners,
      ]);
      const allowedNames = new Set([...agentConfig.tools.map((t) => t.name), ...loadedToolNames]);
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
          disposers: [
            () => mailTools.dispose(),
            () => posixTools.dispose(),
            ...loadedDisposers,
            () => eventForwarding,
          ],
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
