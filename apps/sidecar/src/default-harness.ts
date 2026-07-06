import fs from "node:fs";
import path from "node:path";
import { evaluateGrants } from "@intx/authz";
import { createToolRunner, defineTool } from "@intx/agent";
import {
  createWorkbenchDirectorRegistry,
  toLlmToolName,
  resolveDynamicToolConfig,
  DYNAMIC_TOOLS_DIRECTOR_ID,
} from "@workbench/agents";
import {
  createCatalogTools,
  DYNAMIC_TOOLS_ENV_KEY,
  type ToolExposureState,
} from "@workbench/tools-catalog";
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
import { readDeployTree } from "@workbench/hub-agent";
import { createDependencies, type AdapterRegistry } from "@intx/inference";
import { getLogger } from "@intx/log";
import {
  createIsogitStore,
  createMailAuditStore,
  type GCPolicy,
} from "@workbench/storage-isogit";
import { createMailTools } from "@intx/tools-mail";
import { createPosixTools } from "@intx/tools-posix";
import { createBlobReader } from "@intx/types/runtime";
import type { InferenceSource } from "@intx/types/runtime";
import type { HarnessBuilder, HarnessBundle } from "@workbench/hub-agent";
import { resolveSeedMarker, stripSeedMarker } from "@workbench/agents/seed";
import { PERSONAL_AGENT_NAME } from "@workbench/agents";
import { createAskPrincipalTool } from "@workbench/approvals";
import { seedWorkspaceFiles } from "./seed-workspace-files";
import { healTurns } from "@workbench/context-repair";
import { withActiveContext } from "@workbench/prompts";
import { createGuardedMailRunner } from "./mail-guard";
import {
  APPROVAL_GATED_TOOLS,
  createApprovalClient,
  createApprovalGatedRunner,
} from "./approval-gate";
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
  if (systemPrompt.includes(`You are ${PERSONAL_AGENT_NAME}, Chief of Staff`)) {
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
  /**
   * Adapter registry resolved once at the boot edge (built-ins wrapped
   * with the workbench gemini patch). It backs both the `canBuildSource`
   * membership check and the per-agent `env.deps` used to resolve
   * inference adapters at run time, so the in-process single-agent path
   * resolves the same provider set the boot edge configured.
   */
  adapters: AdapterRegistry;
  /**
   * Write-path GC policy for the per-agent context repo. Resolved at the
   * boot edge and handed to `createIsogitStore` so the reactor's commits
   * reclaim the repo once it crosses the policy's thresholds.
   */
  gcPolicy: GCPolicy;
};

export function createDefaultHarnessBuilder({
  hubHttpUrl,
  sidecarToken,
  cacheRoot,
  cacheMaxBytes,
  registryMaxTarballBytes,
  adapters,
  gcPolicy,
}: HarnessBuilderOpts): HarnessBuilder {
  return {
    canBuildSource(source: InferenceSource): void {
      if (!adapters.has(source.provider)) {
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

      const storage = await createIsogitStore(storeDir, signer, gcPolicy);
      await healContextStore(storage, agentAddress);
      const mailStore = await createMailAuditStore(storeDir, signer);

      const deployTree = await readDeployTree(storeDir);
      const basePrompt = deployTree.systemPrompt ?? agentConfig.systemPrompt;

      // Parse the memory-seed file list off the RAW base prompt, then strip the
      // marker before the prompt reaches the model. The marker is a
      // control-plane sentinel for the harness; the live model must never see
      // its own seed instructions (it would surface as raw text the agent could
      // echo or be confused by) — CL-1952.
      const {
        files: declaredSeedFiles,
        skipped: skippedSeedFiles,
        malformed: seedMarkerMalformed,
      } = resolveSeedMarker(basePrompt);
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

      // Dynamic tool exposure (CL-2808): opt-in agents advertise only a base
      // set plus the catalog tools on turn one; the rest are discoverable via
      // search_tools and enabled on demand by load_tools. The exposure set is
      // the shared in-process channel between the catalog tools (which mutate
      // it) and the dynamic-tools director (which reads it per infer). Every
      // tool stays loaded and dispatchable regardless — only advertisement
      // changes. Non-opt-in agents get `undefined` here and are untouched.
      const dynamicToolConfig = resolveDynamicToolConfig(cleanedPrompt);
      const exposureState: ToolExposureState = { exposed: new Set<string>() };
      const catalogRunner =
        dynamicToolConfig !== undefined
          ? (createCatalogTools({
              catalog: dynamicToolConfig.catalog,
              exposure: exposureState,
            }) as DefinedRunner)
          : undefined;

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
      if (seedMarkerMalformed) {
        // A marker present but resolving to nothing — not a seeded file, a
        // skipped name, or a retired one — is a malformed/empty marker, a
        // contract break between the prompt builder and the seed table. Surface
        // it rather than silently seed nothing (CL-1952). A marker naming only
        // since-retired files (an old prompt's MEMORY.md, CL-2413) resolves to
        // `retired`, not malformed, and stays silent (CL-2509).
        logger.warn(
          "Seed marker for {address} resolved zero files (malformed)",
          {
            address: agentAddress,
          },
        );
      }
      if (skippedSeedFiles.length > 0) {
        // An OLD persisted prompt may name a since-folded seed file. Skip it and
        // warn rather than abort the harness build — a stale marker must never
        // wedge a live session on restore (CL-2364).
        logger.warn(
          "Seed marker for {address} named unresolvable file(s); skipping: {skipped}",
          {
            address: agentAddress,
            skipped: skippedSeedFiles.join(", "),
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

      // Reverse-order disposal stack: each resource pushes its own disposer
      // right after it is allocated, so both the failure path (below) and the
      // success-path `disposers` return value walk the same list — a resource
      // can never be "forgotten" by a hand-maintained parallel list again
      // (CL-2814; CL-2813 had to add the tool-package disposers after the fact
      // because the failure catch hand-listed only mail/posix).
      const cleanup: (() => Promise<void>)[] = [];

      // Open the guarded region immediately: posixTools/mailTools are pushed to
      // `cleanup` below, and loadToolPackages (a documented HARD-throw gate),
      // fetchToolCredentials, and the factory loop all run before createHarness.
      // A throw from any of them must still walk `cleanup` and dispose what was
      // already allocated (CL-2814) — otherwise a loadToolPackages failure leaks
      // posix+mail, the exact CL-2813 bug class relocated upstream.
      try {
        const blobReader = createBlobReader(storage);
        const posixTools = createPosixTools({
          cwd: workDir,
          blobReader,
        });
        cleanup.push(() => posixTools.dispose());

        const capabilities = createHarnessRuntimeCapabilities({
          transport: agentTransport,
        });
        const mailTools = createMailTools({ capabilities });
        cleanup.push(() => mailTools.dispose());
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
          // Resolve inference adapters through the boot-edge registry so the
          // agent uses the same (gemini-patched) provider set `canBuildSource`
          // admitted, not `createAgent`'s built-ins-only default.
          deps: createDependencies(adapters),
          transport: agentTransport,
          address: agentAddress,
          onConnectorStateChanged,
          ...credentialEnv,
          [HUB_RPC_ENV_KEY]: hubRpcContext,
          ...(dynamicToolConfig !== undefined
            ? {
                [DYNAMIC_TOOLS_ENV_KEY]: {
                  catalog: dynamicToolConfig.catalog,
                  exposure: exposureState,
                },
              }
            : {}),
        };

        const loadedRunners: DefinedRunner[] = [];
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
            // The loader prefixes every tool with `<factoryId>:<name>`
            // (e.g. `@workbench/tools-exa/exa:exa_search`). That string carries
            // `@`, `/`, and `:`, which violate LLM function-name constraints and do
            // not round-trip (kimi truncates at the `:`), so the model's tool call
            // never matches its grant or the loader's dispatch entry. Present an
            // LLM-safe alias to the model and translate it back to the canonical
            // name before delegating to the bundle's run() (CL-2306).
            const aliasToCanonical = new Map<string, string>();
            const safeDefinitions = bundle.definitions.map((def) => {
              const safe = toLlmToolName(def.name);
              aliasToCanonical.set(safe, def.name);
              return { ...def, name: safe };
            });
            loadedRunners.push({
              definitions: safeDefinitions,
              run: (call, signal) =>
                bundle.run(
                  {
                    ...call,
                    name: aliasToCanonical.get(call.name) ?? call.name,
                  },
                  signal,
                ),
            });
            for (const def of safeDefinitions) loadedToolNames.add(def.name);
            if (bundle.dispose !== undefined) {
              cleanup.push(async () => {
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
          ...(catalogRunner !== undefined ? [catalogRunner] : []),
          ...loadedRunners,
        ]);
        // Enforce human approval for irreversible tools at the composition
        // seam (the harness-side stand-in for an `ask` grant; see
        // approval-gate.ts).
        const gatedTools = createApprovalGatedRunner(
          allTools as DefinedRunner,
          {
            gatedTools: APPROVAL_GATED_TOOLS,
            approve: createApprovalClient({
              hubHttpUrl,
              sidecarToken,
              tenantId,
              agentId: agentConfig.agentId,
              principalId,
            }),
          },
        );
        const allowedNames = new Set([
          ...agentConfig.tools.map((t) => t.name),
          ...loadedToolNames,
          ...(catalogRunner !== undefined
            ? catalogRunner.definitions.map((d) => d.name)
            : []),
        ]);
        const tools = filterToolRunner(
          gatedTools as DefinedRunner,
          allowedNames,
        );

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
          ...(dynamicToolConfig !== undefined
            ? { director: { id: DYNAMIC_TOOLS_DIRECTOR_ID, config: {} } }
            : {}),
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
          // `eventForwarding` is only started once createHarness has
          // succeeded, so it belongs on the success-path disposer list only —
          // never on `cleanup`, which the failure catch below also walks.
          disposers: [...cleanup, () => eventForwarding],
        };
      } catch (err) {
        // Honor the harness-builder disposal contract
        // (packages/hub-agent/src/harness-builder.ts:71) — a mid-build
        // failure (e.g. the address is deregistered during `createHarness` on
        // a reconnect storm) must dispose every resource allocated so far,
        // not just some hand-picked subset. Walk `cleanup` in reverse
        // allocation order (CL-2814) — standard teardown, tearing down
        // later-allocated resources first. This is the OPPOSITE of the success
        // path, which returns `cleanup` forward for session-manager to consume
        // in allocation order; ordering is immaterial here (the disposers are
        // independent), so the two directions are equally safe. Each disposal
        // is independently guarded so one failure cannot abort the rest, and
        // the ORIGINAL build error is rethrown below — never a disposer error.
        for (let i = cleanup.length - 1; i >= 0; i--) {
          const dispose = cleanup[i];
          if (dispose === undefined) continue;
          try {
            await dispose();
          } catch (disposeErr) {
            const msg =
              disposeErr instanceof Error
                ? disposeErr.message
                : String(disposeErr);
            logger.warn("disposer failed during harness rollback: {msg}", {
              msg,
            });
          }
        }
        throw err;
      }
    },
  };
}
