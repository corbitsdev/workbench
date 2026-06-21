import fs from "node:fs";
import path from "node:path";
import { evaluateGrants } from "@intx/authz";
import { createToolRunner, defineTool } from "@intx/agent";
import { createWorkbenchDirectorRegistry } from "@workbench/agents";
import {
  HUB_RPC_ENV_KEY,
  providerFromEnvKey,
} from "@workbench/tool-credentials";
import {
  mergeToolRunners,
  fetchToolCredentials,
  filterToolRunner,
  loadToolPackages,
  wsUrlToHttp,
  type DefinedRunner,
} from "./agent-tools";
import { createHarness, createHarnessRuntimeCapabilities } from "@intx/harness";
import { readDeployTree } from "@intx/hub-agent";
import { hasProvider } from "@intx/inference";
import { getLogger } from "@intx/log";
import { createIsogitStore, createMailAuditStore } from "@intx/storage-isogit";
import { createMailTools } from "@intx/tools-mail";
import { createPosixTools } from "@intx/tools-posix";
import { createBlobReader } from "@intx/types/runtime";
import type { InferenceSource } from "@intx/types/runtime";
import type { HarnessBuilder, HarnessBundle } from "@intx/hub-agent";
import {
  hasSeedMarker,
  parseSeedMarker,
  stripSeedMarker,
} from "@workbench/agents/seed";
import { PERSONAL_AGENT_NAME } from "@workbench/agents";
import { createAskPrincipalTool } from "@workbench/approvals";
import { seedWorkspaceFiles } from "./seed-workspace-files";
import { healTurns } from "@workbench/context-repair";
import { withActiveContext } from "@workbench/prompts";
import { createGuardedMailRunner } from "./mail-guard";
import type { ContextStore } from "@intx/types/runtime";

const logger = getLogger(["sidecar", "harness-builder"]);
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
export async function healContextStore(
  storage: ContextStore,
  agentAddress: string,
): Promise<void> {
  const { turns } = await storage.load();
  const healed = healTurns(turns);
  if (!healed.changed) return;

  await storage.writeTurns(healed.turns);
  await storage.commit({
    message: "recover: heal unsendable turns and tool_call pairing",
  });
  logger.warn(
    "Healed context for {address}: removed {removed} unsendable turn(s), synthesized {synth} tool result(s), dropped {dangling} dangling result(s)",
    {
      address: agentAddress,
      removed: healed.unsendableRemoved,
      synth: healed.toolResultsSynthesized,
      dangling: healed.danglingResultsDropped,
    },
  );
}

export {
  mergeToolRunners as combineRunners,
  wsUrlToHttp,
  fetchToolCredentials,
};

export function resolveMailOutboundLimit(systemPrompt: string): number {
  if (
    systemPrompt.includes(
      `${PERSONAL_AGENT_NAME} is a Chief of Staff and Executive Assistant`,
    )
  ) {
    return PERSONAL_AGENT_MAIL_OUTBOUND_PER_TURN;
  }
  return DEFAULT_MAIL_OUTBOUND_PER_TURN;
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
        throw new Error(
          `Source provider "${source.provider}" is not registered`,
        );
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
      const systemPrompt = withActiveContext(cleanedPrompt, {
        now: new Date(),
      });

      const grantsRef = { current: agentConfig.grants };
      const { principalId, tenantId } = agentConfig;
      const authorize = async (resource: string, action: string) =>
        evaluateGrants(grantsRef.current, resource, action, {
          principalId,
          tenantId,
        });

      const workDir = path.join(storeDir, "workspace");
      await fs.promises.mkdir(workDir, { recursive: true });

      // Seed the memory files the agent documents but does not create itself, so
      // its first read never fails (CL-1952). Marker presence IS the signal: a
      // prompt with no marker is simply a non-marker-bearing agent (normal), so
      // there is no phrase-based heuristic to guess "should have been seeded".
      if (declaredSeedFiles.length === 0 && hasSeedMarker(basePrompt)) {
        // A marker that resolves zero files is a malformed/empty marker — a
        // contract break between the prompt builder and the seed table. Surface
        // it rather than silently seed nothing (CL-1952).
        logger.warn(
          "Seed marker for {address} resolved zero files (malformed)",
          {
            address: agentAddress,
          },
        );
      }
      const seedResult = await seedWorkspaceFiles(workDir, declaredSeedFiles);
      logger.info(
        "Seeded {created} workspace file(s) for {address}, skipped {skipped} existing",
        {
          address: agentAddress,
          created: seedResult.created,
          skipped: seedResult.skipped,
        },
      );

      const blobReader = createBlobReader(storage);
      const posixTools = createPosixTools({
        cwd: workDir,
        blobReader,
      });

      const capabilities = createHarnessRuntimeCapabilities({
        transport: agentTransport,
      });
      const mailTools = createMailTools({ capabilities });
      const guardedMailTools = createGuardedMailRunner(
        mailTools as DefinedRunner,
        {
          maxOutboundPerTurn: resolveMailOutboundLimit(cleanedPrompt),
        },
      );

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
            logger.warn(
              "Tool-package factory {id} failed to construct for {address}: {msg}",
              {
                id: factory.id,
                address: agentAddress,
                msg: err instanceof Error ? err.message : String(err),
              },
            );
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
        logger.info("Loaded {count} native tool(s) for {address}: {names}", {
          count: loadedToolNames.size,
          address: agentAddress,
          names: [...loadedToolNames].join(", "),
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
      const allowedNames = new Set([
        ...agentConfig.tools.map((t) => t.name),
        ...loadedToolNames,
      ]);
      const tools = filterToolRunner(allTools as DefinedRunner, allowedNames);

      try {
        const toolsFactory = defineTool({
          id: "@workbench/sidecar/tools",
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
              if (event.type === "message.received") {
                guardedMailTools.resetOutboundBudget();
                continue;
              }
              onEvent(event);
            }
          } catch (err) {
            logger.warn(
              "Harness event forwarding stopped for {address}: {msg}",
              {
                address: agentAddress,
                msg: err instanceof Error ? err.message : String(err),
              },
            );
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
          const msg =
            disposeErr instanceof Error
              ? disposeErr.message
              : String(disposeErr);
          logger.warn(
            "mailTools.dispose failed during harness rollback: {msg}",
            { msg },
          );
        }
        try {
          await posixTools.dispose();
        } catch (disposeErr) {
          const msg =
            disposeErr instanceof Error
              ? disposeErr.message
              : String(disposeErr);
          logger.warn(
            "posixTools.dispose failed during harness rollback: {msg}",
            { msg },
          );
        }
        throw err;
      }
    },
  };
}
