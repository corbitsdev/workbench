// Tool-capable harness for workflow STEP agents.
//
// A live agent's harness (`default-harness.ts`) loads its pinned tool
// packages from an on-disk deploy pack (`readDeployTree`), resolves the
// provider credentials those packages declare over the hub, and exposes
// hub-backed tool packages via a hub-RPC context. A workflow step runs in
// the shared `bin/workflow-child` and has none of that: no deploy pack, no
// agent transport, no per-instance launch. This module gives a step agent
// the same tool surface by fetching the resolved manifest + tarballs from
// the hub's `/api/internal/tools/manifest` rail, materializing the tarballs
// on disk, and loading them through the same `@intx/tool-packaging` loader
// the live path uses. Tool credentials and the hub-RPC context are resolved
// the same way too — so a step's Granola/Gamma/Reddit/image tools work
// end-to-end and are gated identically (by the step's persisted `agent` row).

import fs from "node:fs";
import path from "node:path";
import { type } from "arktype";
import { createAgent, defineTool } from "@intx/agent";
import type { Agent, AgentDefinition, BaseEnv } from "@intx/agent";
import { evaluateGrants } from "@intx/authz";
import type { GrantRule } from "@intx/authz";
import { createHarnessRuntimeCapabilities } from "@intx/harness";
import { getLogger } from "@intx/log";
import { createBlobReader } from "@intx/types/runtime";
import type { ContextStore, MessageTransport } from "@intx/types/runtime";
import { createMailTools } from "@intx/tools-mail";
import { createPosixTools } from "@intx/tools-posix";
import {
  HUB_RPC_ENV_KEY,
  ToolManifestResponse,
  providerFromEnvKey,
} from "@workbench/tool-credentials";
import {
  ArgMap,
  WORKFLOW_STEP_BUDGET_DIRECTOR_ID,
  DYNAMIC_TOOLS_DIRECTOR_ID,
  TRIAGE_BUDGET_DIRECTOR_ID,
  INVOKE_BUDGET_DIRECTOR_ID,
  resolveDynamicToolConfig,
} from "@workbench/agents";
import {
  isTriageSessionPrompt,
  isInvokeSessionPrompt,
  resolveSeedMarker,
  stripSeedMarker,
  resolveInferenceParamsMarker,
  stripInferenceParamsMarker,
  INFERENCE_PARAMS_ENV_KEY,
  type ResolvedInferenceDials,
  type SeedWorkspaceFile,
} from "@workbench/myra";
import {
  resolveTimeZoneMarker,
  stripTimeZoneMarker,
  withActiveContext,
} from "@workbench/prompts";
import { seedWorkspaceFiles } from "./seed-workspace-files";
import {
  catalogManagedNames,
  createCatalogTools,
  filterCatalogByAvailableTools,
  filterExposureToCatalog,
  persistExposure,
  readPersistedExposure,
  DYNAMIC_TOOLS_ENV_KEY,
  type ToolCatalog,
  type ToolExposureState,
} from "@workbench/tools-catalog";
import {
  fetchToolCredentials,
  loadToolPackages,
  mergeToolRunners,
  filterToolRunner,
  type DefinedRunner,
} from "./agent-tools";
import { buildDispatchAllowedToolNames } from "./tool-dispatch-allowed-names";
import { createGuardedMailRunner } from "./mail-guard";
import type { DirectorRef } from "@intx/agent";

const logger = getLogger(["sidecar", "step-tool-harness"]);

/**
 * Pure director-id selection for a WARM single-step agent (Myra/Oat/triage/
 * gate), re-homed verbatim from the retired `default-harness.ts`
 * `selectDirectorId` when the in-process harness runtime was replaced by the
 * single-step-workflow launch path. A triage session always gets the triage
 * budget director and an invoked-subagent session always gets the invoke
 * budget director — both regardless of dynamic tool config, since each budget
 * director's factory composes the dynamic-tools director internally when the
 * harness env carries it. Triage takes priority over invoke in the (impossible
 * in practice) case both markers were present. A plain agent with dynamic tool
 * config gets the dynamic-tools director; everything else falls back to the
 * registry default (`undefined`). Genuine multi-step workflow steps never reach
 * this function — they are pinned to the budget director unconditionally.
 */
export function selectDirectorId(params: {
  isTriageSession: boolean;
  isInvokeSession: boolean;
  hasDynamicToolConfig: boolean;
}): string | undefined {
  if (params.isTriageSession) return TRIAGE_BUDGET_DIRECTOR_ID;
  if (params.isInvokeSession) return INVOKE_BUDGET_DIRECTOR_ID;
  if (params.hasDynamicToolConfig) return DYNAMIC_TOOLS_DIRECTOR_ID;
  return undefined;
}

/**
 * A workflow step declared a tool that was not pinned/loaded into the step's
 * runner — the exact failure when a tool's package-registry tarball is stale or
 * missing, so the tool never "links up" for the deployment. Named + carrying the
 * tool name and the set of tools that DID load, so the run-failure detail and the
 * Sentry event are explicit and actionable instead of a generic step failure.
 */
export class StepToolNotRegisteredError extends Error {
  readonly toolName: string;
  readonly loadedTools: readonly string[];
  constructor(toolName: string, loadedTools: readonly string[]) {
    const loaded = loadedTools.length > 0 ? loadedTools.join(", ") : "none";
    super(
      `tool "${toolName}" is not registered/available for this deployment ` +
        `(the workflow step declared a tool that is not pinned; loaded tools: ${loaded})`,
    );
    this.name = "StepToolNotRegisteredError";
    this.toolName = toolName;
    this.loadedTools = loadedTools;
  }
}

/**
 * Throw a clear, named {@link StepToolNotRegisteredError} when a step's declared
 * tool is absent from the tools that actually loaded for the step.
 */
export function assertStepToolAvailable(
  toolName: string,
  available: ReadonlySet<string>,
): void {
  if (!available.has(toolName)) {
    throw new StepToolNotRegisteredError(toolName, [...available]);
  }
}

/**
 * Per-step identity + hub-connection context the step agentFactory needs
 * to materialize tools. `buildEnv` (which has the StepInvokeRequest in
 * scope) stashes this on the env under `STEP_TOOL_CONTEXT_KEY`; the
 * agentFactory reads it back. Kept off `BaseEnv`'s typed surface because it
 * is sidecar-internal plumbing, not an agent-runtime contract.
 */
export interface StepToolContext {
  hubHttpUrl: string;
  sidecarToken: string;
  tenantId: string;
  /** The step's persisted `agent` row id (`deriveStepAgentId`). */
  stepAgentId: string;
  /** Stable address used in logs + hub-RPC identity. */
  stepAddress: string;
  /** Synthetic per-step principal id used for grant evaluation. */
  principalId: string;
  /** Workflow run id for run-creator member OAuth on tool-credentials. */
  workflowRunId?: string;
  /** The step's grants, read from its agent-state repo. */
  grants: GrantRule[];
  cacheRoot: string;
  cacheMaxBytes: number;
  registryMaxTarballBytes: number;
}

export const STEP_TOOL_CONTEXT_KEY = "workbench.stepToolContext";

/**
 * Fetch the step agent's resolved tool-package manifest plus the raw bytes
 * of every asset-sourced tarball it references, then materialize those
 * tarballs under `<storeDir>/workspace/<mount>/<path>` so the loader's
 * `assetMounts` map resolves exactly as the live path's deploy-pack write
 * would. Returns the raw manifest bytes and the reconstructed assetMounts.
 *
 * Fail-soft on transport/validation errors: returns no manifest, so the
 * step runs with local tools only rather than failing the whole step.
 */
export async function fetchStepToolManifest(args: {
  ctx: StepToolContext;
  storeDir: string;
}): Promise<{
  rawManifestBytes: string | undefined;
  assetMounts: Map<string, string>;
}> {
  const empty = {
    rawManifestBytes: undefined,
    assetMounts: new Map<string, string>(),
  };
  let response: Response;
  try {
    response = await fetch(
      `${args.ctx.hubHttpUrl}/api/internal/tools/manifest`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.ctx.sidecarToken}`,
        },
        body: JSON.stringify({
          tenantId: args.ctx.tenantId,
          agentId: args.ctx.stepAgentId,
        }),
      },
    );
  } catch (err) {
    logger.warn("Step tool-manifest fetch failed for {address}: {msg}", {
      address: args.ctx.stepAddress,
      msg: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
  if (!response.ok) {
    logger.warn("Step tool-manifest fetch for {address} returned {status}", {
      address: args.ctx.stepAddress,
      status: response.status,
    });
    return empty;
  }
  const parsed = ToolManifestResponse(await response.json());
  if (parsed instanceof type.errors) {
    logger.warn(
      "Step tool-manifest response for {address} failed validation: {summary}",
      {
        address: args.ctx.stepAddress,
        summary: parsed.summary,
      },
    );
    return empty;
  }

  const workspaceRoot = path.join(args.storeDir, "workspace");
  const assetMounts = new Map<string, string>();
  for (const tarball of parsed.tarballs) {
    if (path.isAbsolute(tarball.mount) || tarball.mount.includes("..")) {
      logger.warn(
        "Step tool-manifest tarball mount rejected for {address}: {mount}",
        {
          address: args.ctx.stepAddress,
          mount: tarball.mount,
        },
      );
      return empty;
    }
    const destDir = path.join(workspaceRoot, tarball.mount);
    const destPath = path.join(destDir, tarball.path);
    const containment = workspaceRoot.endsWith(path.sep)
      ? workspaceRoot
      : workspaceRoot + path.sep;
    if (!destPath.startsWith(containment)) {
      logger.warn(
        "Step tool-manifest tarball path escaped workspace for {address}",
        {
          address: args.ctx.stepAddress,
        },
      );
      return empty;
    }
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.writeFile(
      destPath,
      Buffer.from(tarball.bytesBase64, "base64"),
    );
    assetMounts.set(tarball.assetId, tarball.mount);
  }

  return { rawManifestBytes: JSON.stringify(parsed.manifest), assetMounts };
}

/**
 * Read the step's tool context off the env. Throws if absent — the
 * agentFactory is only ever paired with the env builder that stashes it, so
 * a miss is a wiring fault worth surfacing loudly.
 */
function readStepToolContext(env: Record<string, unknown>): StepToolContext {
  const raw = env[STEP_TOOL_CONTEXT_KEY];
  if (raw === undefined) {
    throw new Error(
      "step-tool-harness: STEP_TOOL_CONTEXT was not stashed on the step env; buildEnv must set it before the agentFactory runs",
    );
  }
  // Internal value the env builder constructed in-process this same run; it
  // never crosses a trust boundary, so a plain narrowing cast is sound.

  return raw as StepToolContext;
}

/**
 * Build the merged, filtered tool runner for a step agent: its pinned
 * native tool packages (materialized from the hub manifest), the provider
 * credentials they declare, the hub-RPC context for hub-backed packages,
 * and local posix tools. Returns the runner plus the disposers the agent
 * lifetime must run.
 */
async function buildStepTools(args: {
  ctx: StepToolContext;
  env: BaseEnv;
  storage: ContextStore;
  workdir: string;
}): Promise<{
  runner: DefinedRunner;
  loadedToolNames: Set<string>;
  /**
   * Native tool-package tool names only (posix/mail excluded). These are the
   * catalog-gated candidates: the warm single-step path admits them through
   * the dispatch allow-list only when the member is granted them.
   */
  packageToolNames: Set<string>;
  /**
   * Always-allowed local tool names (posix + mail). The warm single-step
   * dispatch allow-list never gates these — they mirror the hub-proxy/local
   * `agentConfig.tools` names the retired `default-harness` treated as
   * unconditionally granted.
   */
  localToolNames: Set<string>;
  disposers: (() => Promise<void>)[];
}> {
  const { ctx } = args;
  const storeDir = path.dirname(args.workdir);

  const manifestStart = performance.now();
  const { rawManifestBytes, assetMounts } = await fetchStepToolManifest({
    ctx,
    storeDir,
  });
  const manifestMs = performance.now() - manifestStart;

  const loadStart = performance.now();
  const loadedPackages = await loadToolPackages({
    rawManifestBytes,
    assetMounts,
    storeDir,
    agentAddress: ctx.stepAddress,
    cacheRoot: ctx.cacheRoot,
    cacheMaxBytes: ctx.cacheMaxBytes,
    registryMaxTarballBytes: ctx.registryMaxTarballBytes,
  });
  const loadMs = performance.now() - loadStart;

  const requiredProviders = new Set<string>();
  for (const pkg of loadedPackages) {
    for (const factory of pkg.factories) {
      for (const key of factory.requires) {
        const provider = providerFromEnvKey(key);
        if (provider !== undefined) requiredProviders.add(provider);
      }
    }
  }
  const credStart = performance.now();
  const credentialEnv = await fetchToolCredentials({
    hubHttpUrl: ctx.hubHttpUrl,
    sidecarToken: ctx.sidecarToken,
    tenantId: ctx.tenantId,
    agentId: ctx.stepAgentId,
    providerNames: [...requiredProviders],
    agentAddress: ctx.stepAddress,
    ...(ctx.workflowRunId !== undefined
      ? { workflowRunId: ctx.workflowRunId }
      : {}),
  });
  const credMs = performance.now() - credStart;

  logger.info(
    "Step tool build timing for {address}: manifest={manifestMs}ms load={loadMs}ms credentials={credMs}ms packages={packages} providers={providers}",
    {
      address: ctx.stepAddress,
      manifestMs: Math.round(manifestMs),
      loadMs: Math.round(loadMs),
      credMs: Math.round(credMs),
      packages: loadedPackages.length,
      providers: requiredProviders.size,
    },
  );

  const hubRpcContext = {
    baseURL: ctx.hubHttpUrl,
    token: ctx.sidecarToken,
    tenantId: ctx.tenantId,
    agentId: ctx.stepAgentId,
    principalId: ctx.principalId,
    // Steps are not session-bound; the hub-RPC rail accepts an empty
    // sessionId for non-session callers.
    sessionId: "",
  };

  const blobReader = createBlobReader(args.storage);
  const posixTools = createPosixTools({
    cwd: args.workdir,
    blobReader,
  });

  // The factory env is the agent env plus the credential + hub-RPC keys the
  // tool-package factories declare via `requires`.
  const factoryEnv = {
    ...args.env,
    ...credentialEnv,
    [HUB_RPC_ENV_KEY]: hubRpcContext,
  };

  const loadedRunners: DefinedRunner[] = [];
  const disposers: (() => Promise<void>)[] = [() => posixTools.dispose()];
  const loadedToolNames = new Set<string>();
  const packageToolNames = new Set<string>();
  const localToolNames = new Set<string>();
  for (const def of posixTools.definitions) localToolNames.add(def.name);
  for (const pkg of loadedPackages) {
    for (const factory of pkg.factories) {
      let bundle: ReturnType<typeof factory>;
      try {
        bundle = factory(factoryEnv);
      } catch (err) {
        // Tool packages load from published tarballs, so this may be a
        // different bundle copy of ToolCredentialMissingError than the one
        // in this process — `instanceof` can miss across bundles. `err.name`
        // survives bundling, so match on it instead.
        if (err instanceof Error && err.name === "ToolCredentialMissingError") {
          logger.info(
            "Tool package {id} skipped for {address}: no credential configured for provider {providerName}",
            {
              id: factory.id,
              address: ctx.stepAddress,
              providerName: (err as { providerName?: string }).providerName,
            },
          );
          continue;
        }
        logger.warn(
          "Step tool-package factory {id} failed to construct for {address}: {msg}",
          {
            id: factory.id,
            address: ctx.stepAddress,
            msg: err instanceof Error ? err.message : String(err),
          },
        );
        continue;
      }
      loadedRunners.push({
        definitions: [...bundle.definitions],
        run: (call, signal) => bundle.run(call, signal),
      });
      for (const def of bundle.definitions) {
        loadedToolNames.add(def.name);
        packageToolNames.add(def.name);
      }
      if (bundle.dispose !== undefined) {
        const dispose = bundle.dispose;
        disposers.push(async () => {
          await dispose();
        });
      }
    }
  }
  if (loadedToolNames.size > 0) {
    logger.info("Loaded {count} native tool(s) for step {address}: {names}", {
      count: loadedToolNames.size,
      address: ctx.stepAddress,
      names: [...loadedToolNames].join(", "),
    });
  }

  const runners: DefinedRunner[] = [posixTools, ...loadedRunners];

  // The workflow substrate injects an in-process mail transport on the step
  // env (env.transport) whenever the deployment has a mailbox. Mail is a
  // local runner, never a pinned package, so it must be merged here for a
  // deterministic `mail_send` step to resolve — mirroring the live agent
  // harness. Guard on presence: pure-inference deployments and test seams
  // inject no transport and get no mail tools. The env value is constructed
  // in-process by the substrate this same run and never crosses a trust
  // boundary, so a plain narrowing cast is sound (same reasoning as
  // readStepToolContext).
  const transport = (args.env as unknown as Record<string, unknown>).transport;
  if (transport !== undefined) {
    const mailTools = createMailTools({
      capabilities: createHarnessRuntimeCapabilities({
        transport: transport as MessageTransport,
      }),
    });
    // A deterministic step performs exactly one declared send; anything more
    // is a fault the guard should block.
    runners.push(
      createGuardedMailRunner(mailTools as DefinedRunner, {
        maxOutboundPerTurn: 1,
      }),
    );
    disposers.push(() => mailTools.dispose());
    for (const def of mailTools.definitions) {
      loadedToolNames.add(def.name);
      localToolNames.add(def.name);
    }
  }

  // Steps expose every materialized native tool plus local posix tools; the
  // grants-backed `authorize` the factory installs is the real per-call gate,
  // and the hub gates which packages were resolvable at all via the step's
  // pins. No name-filter is applied here — it would be a no-op (every loaded
  // tool name is already in the merged set).
  const merged = mergeToolRunners(runners) as DefinedRunner;
  return {
    runner: merged,
    loadedToolNames,
    packageToolNames,
    localToolNames,
    disposers,
  };
}

export interface PreparedWarmAgentPrompt {
  /** Prompt with every control-plane marker stripped and the active-context
   * block appended — what the model actually sees. */
  systemPrompt: string;
  /** Memory-seed files the agent documents but does not create itself. */
  seedFiles: readonly SeedWorkspaceFile[];
  /** True when a seed marker was present but resolved to zero files (a
   * malformed marker / prompt-builder contract break). */
  seedMalformed: boolean;
  /** Member inference dials to thread via env; see the note below on WHY env. */
  inferenceDials: ResolvedInferenceDials | undefined;
}

/**
 * Re-home the retired `default-harness`'s prompt-marker handling onto the WARM
 * single-step agent path. The hub stamps control-plane markers onto the launch
 * prompt for the harness to act on: `workbench:memory-seed` (files to seed),
 * the member-timezone marker (active-context date zone), and
 * `workbench:inference-params` (member dials). With the in-process harness
 * retired, NOTHING resolved them on the warm path — so all three markers leaked
 * into the model prompt as raw text, the seed files were never seeded, and the
 * live active-context (date) block was never applied, re-anchoring the agent to
 * its training cutoff (the CL-1938 regression). The inference dials survived
 * only incidentally, because the director still read the un-stripped marker off
 * `agent.systemPrompt`.
 *
 * This resolves all three markers, strips them, and appends a fresh
 * active-context block. Crucially it returns the dials to thread via ENV rather
 * than leaving them on the prompt: `readInferenceParamsForDirector` reads env
 * BEFORE the prompt marker, so once the marker is stripped the director must
 * get the dials from env or the member's dials are silently lost. Pure so the
 * marker/strip/active-context contract is unit-testable without a harness.
 */
export function prepareWarmAgentPrompt(
  rawSystemPrompt: string,
  now: Date,
): PreparedWarmAgentPrompt {
  const seed = resolveSeedMarker(rawSystemPrompt);
  const timeZone = resolveTimeZoneMarker(rawSystemPrompt);
  const inferenceDials = resolveInferenceParamsMarker(rawSystemPrompt);
  const cleaned = stripInferenceParamsMarker(
    stripTimeZoneMarker(stripSeedMarker(rawSystemPrompt)),
  );
  const systemPrompt = withActiveContext(cleaned, {
    now,
    ...(timeZone !== undefined ? { timeZone } : {}),
  });
  return {
    systemPrompt,
    seedFiles: seed.files,
    seedMalformed: seed.malformed,
    inferenceDials,
  };
}

/**
 * Re-home the retired `default-harness` director + dynamic-tools + exposure
 * resolution onto the WARM single-step agent path. A single-step deployment
 * (Myra/Oat/triage/gate agent) is a long-lived tool-capable agent, not a
 * throwaway workflow step — so unlike a multi-step step (pinned to the budget
 * director unconditionally) it resolves its director from its prompt markers
 * and, for the personal agent, gets the dynamic tool catalog wired exactly as
 * the pre-bump in-process harness did: only a base set plus the catalog tools
 * advertised on turn one, the long-tail discoverable via `search_tools` and
 * enabled by `load_tools`, with the exposure set persisted so it survives a
 * harness/child rebuild.
 *
 * Returns the (possibly catalog-augmented, allow-list-filtered) runner, the
 * director ref to pin on the step def, and the dynamic-tools env slot the
 * director reads. When the definition declares its own `director` it is
 * respected verbatim; otherwise the marker-driven `selectDirectorId` chooses.
 */
async function resolveWarmAgentHarness(args: {
  def: { systemPrompt: string; director?: DirectorRef };
  runner: DefinedRunner;
  packageToolNames: ReadonlySet<string>;
  localToolNames: ReadonlySet<string>;
  authorize: (
    resource: string,
    action: string,
  ) => Promise<{ effect: string | null }>;
  storeDir: string;
  address: string;
}): Promise<{
  runner: DefinedRunner;
  director: DirectorRef | undefined;
  dynamicEnv: Record<string, unknown>;
}> {
  const { def, storeDir, address } = args;
  const dynamicToolConfig = resolveDynamicToolConfig(def.systemPrompt);
  const isTriageSession = isTriageSessionPrompt(def.systemPrompt);
  const isInvokeSession = isInvokeSessionPrompt(def.systemPrompt);

  const directorId =
    def.director?.id ??
    selectDirectorId({
      isTriageSession,
      isInvokeSession,
      hasDynamicToolConfig: dynamicToolConfig !== undefined,
    });
  const director: DirectorRef | undefined =
    def.director ??
    (directorId !== undefined ? { id: directorId, config: {} } : undefined);

  if (dynamicToolConfig === undefined) {
    // No dynamic catalog: full advertisement, no allow-list gate — identical
    // to the retired harness's `grantedCatalogToolNames === undefined` path.
    return { runner: args.runner, director, dynamicEnv: {} };
  }

  // Gate the catalog to tools this agent is GRANTED (the `tool:<llm-name>/
  // invoke` grant rows), not to tools that happened to load: a package whose
  // credential is missing is still catalogued from manifest metadata so the
  // model can discover it via `search_tools`, while `createCatalogTools`
  // (`availableToolNames`) stops `load_tools` exposing a name with no live
  // runner (CL-3795).
  const grantedCatalogToolNames = new Set<string>();
  for (const name of catalogManagedNames(dynamicToolConfig.catalog)) {
    const decision = await args.authorize(`tool:${name}`, "invoke");
    if (decision.effect === "allow") grantedCatalogToolNames.add(name);
  }
  const availableCatalog: ToolCatalog = filterCatalogByAvailableTools(
    dynamicToolConfig.catalog,
    grantedCatalogToolNames,
  );

  // Rehydrate the exposure set persisted by earlier turns: a child rebuild
  // (respawn / idle wake) starts with a fresh set, which would silently drop
  // every tool the model already loaded. Only names still catalogued AND
  // backed by a live runner are restored, so retired or credential-less tools
  // never come back dead. A corrupt file degrades to empty (advisory state)
  // rather than failing the whole harness build.
  const exposureState: ToolExposureState = { exposed: new Set<string>() };
  const persisted = await readPersistedExposure(storeDir);
  if (persisted.corrupt !== undefined) {
    logger.error(
      "Corrupt tool-exposure state for {address}; proceeding with empty set: {reason}",
      { address, reason: persisted.corrupt },
    );
  }
  const rehydrated = filterExposureToCatalog(
    persisted.exposed,
    availableCatalog,
  ).filter((name) => args.packageToolNames.has(name));
  for (const name of rehydrated) exposureState.exposed.add(name);
  if (rehydrated.length > 0) {
    logger.info("Rehydrated {count} exposed dynamic tool(s) for {address}", {
      count: rehydrated.length,
      address,
    });
  }

  const catalogRunner = createCatalogTools({
    catalog: availableCatalog,
    exposure: exposureState,
    availableToolNames: args.packageToolNames,
    onExposureChanged: (exposed) => {
      void persistExposure(storeDir, exposed).catch((err: unknown) => {
        logger.error("Failed to persist tool exposure for {address}: {error}", {
          address,
          error: String(err),
        });
      });
    },
  }) as DefinedRunner;

  // Loaded package tools are gated on `grantedCatalogToolNames`; local tools
  // (posix/mail) and the catalog control tools (search_tools/load_tools) are
  // always allowed (CL-3848 admission).
  const allowedNames = buildDispatchAllowedToolNames(
    [...args.localToolNames],
    args.packageToolNames,
    catalogRunner.definitions.map((d) => d.name),
    grantedCatalogToolNames,
  );
  const merged = mergeToolRunners([
    args.runner,
    catalogRunner,
  ]) as DefinedRunner;
  const filtered = filterToolRunner(merged, allowedNames);

  return {
    runner: filtered,
    director,
    dynamicEnv: {
      [DYNAMIC_TOOLS_ENV_KEY]: {
        catalog: availableCatalog,
        exposure: exposureState,
      },
    },
  };
}

/**
 * Run a workflow step as a deterministic tool call: load the step's pinned
 * tool packages + credentials the SAME way the tool-capable agent path does,
 * then invoke the named tool DIRECTLY against the runner — no `createAgent`,
 * no `agent.send`, no reactor, no inference. With no `argMap`, the step's
 * runtime-resolved `input` is passed verbatim as the tool-call arguments;
 * with an `argMap`, the tool arguments are reshaped from the evaluated input
 * (`runDeterministicToolStep` parses the argMap JSON at this boundary).
 *
 * Disposal mirrors the agent path: every tool runner disposer runs and the
 * per-step `storeDir` is reclaimed on both success and failure.
 */
/**
 * Pass the evaluated step input verbatim as tool arguments. A step with no
 * `input` selector resolves to null/undefined; for a no-arg tool call that
 * legitimately means "empty arguments", so coerce to {}. A non-null,
 * non-object input (string, number, array) is a real authoring error — the
 * tool's arguments must be an object — so fail loud.
 */
function verbatimToolArguments(
  toolName: string,
  input: unknown,
): Record<string, unknown> {
  if (input === null || input === undefined) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error(
      `step-tool-harness: deterministic step "${toolName}" requires an object (or no) input to use as tool arguments; got ${typeof input}`,
    );
  }

  return input as Record<string, unknown>;
}

/**
 * Result of reshaping a step's evaluated input into tool arguments per its
 * `argMap`. A `skip` result means an OPTIONAL `{ from }` field was absent (or
 * an empty string) on the evaluated input — the caller must not invoke the
 * tool at all, and must not treat this as an error.
 */
export type ArgMapReshapeResult =
  | { skip: true; reason: string }
  | { skip: false; toolArguments: Record<string, unknown> };

/**
 * Reshape the evaluated step input into tool arguments per the step's
 * `argMap`. The argMap JSON is parsed + validated through arktype at this
 * trust boundary. For each `[argName, spec]`: `{ from }` pulls a top-level
 * field off the evaluated input. Non-optional `{ from }`: absence is a
 * missing key on the evaluated step input and fails loud, naming it — an
 * empty string is a real value and passes through unchanged. Optional
 * `{ from, optional: true }`: an absent key OR an empty-string value returns
 * a skip result instead of throwing. `{ literal }` supplies the constant.
 * `{ fromJson, field }` reads `fromJson` off the input, JSON-parses it when
 * it is a string (an already-object value is tolerated), then applies the
 * same presence/optional rules to `field` on the parsed object — for a
 * deterministic step consuming another deterministic tool's `stringTool`
 * output (encoded as `{ content: "<json>" }`).
 */
function reshapeWithArgMap(
  toolName: string,
  input: unknown,
  argMapJson: string,
): ArgMapReshapeResult {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(argMapJson);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `step-tool-harness: deterministic step "${toolName}" has a non-JSON argMap tag: ${reason}`,
    );
  }
  const argMap = ArgMap(parsedJson);
  if (argMap instanceof type.errors) {
    throw new Error(
      `step-tool-harness: deterministic step "${toolName}" argMap failed validation: ${argMap.summary}`,
    );
  }
  const inputRecord =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const toolArguments: Record<string, unknown> = {};
  for (const [argName, spec] of Object.entries(argMap)) {
    if ("literal" in spec) {
      toolArguments[argName] = spec.literal;
      continue;
    }
    if ("fromJson" in spec) {
      const envelope =
        inputRecord !== undefined && spec.fromJson in inputRecord
          ? inputRecord[spec.fromJson]
          : undefined;
      let parsed: unknown = undefined;
      if (typeof envelope === "string") {
        try {
          parsed = JSON.parse(envelope);
        } catch {
          parsed = undefined;
        }
      } else if (envelope !== null && typeof envelope === "object") {
        parsed = envelope;
      }
      const parsedRecord =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
      const fieldPresent =
        parsedRecord !== undefined && spec.field in parsedRecord;
      const fieldValue = fieldPresent ? parsedRecord[spec.field] : undefined;
      if (spec.optional === true) {
        const isEmptyString =
          typeof fieldValue === "string" && fieldValue === "";
        if (!fieldPresent || isEmptyString) {
          return {
            skip: true,
            reason: `deterministic step "${toolName}" argMap maps tool arg "${argName}" from optional JSON field "${spec.field}" of "${spec.fromJson}", which is absent or empty on the evaluated step input`,
          };
        }
        toolArguments[argName] = fieldValue;
        continue;
      }
      if (!fieldPresent) {
        throw new Error(
          `step-tool-harness: deterministic step "${toolName}" argMap maps tool arg "${argName}" from JSON field "${spec.field}" of input field "${spec.fromJson}", but that field is absent on the evaluated step input`,
        );
      }
      toolArguments[argName] = fieldValue;
      continue;
    }
    const present = inputRecord !== undefined && spec.from in inputRecord;
    const rawValue = present ? inputRecord[spec.from] : undefined;
    if (spec.optional === true) {
      const isEmptyString = typeof rawValue === "string" && rawValue === "";
      if (!present || isEmptyString) {
        return {
          skip: true,
          reason: `deterministic step "${toolName}" argMap maps tool arg "${argName}" from optional input field "${spec.from}", which is absent or empty on the evaluated step input`,
        };
      }
      toolArguments[argName] = rawValue;
      continue;
    }
    if (!present) {
      throw new Error(
        `step-tool-harness: deterministic step "${toolName}" argMap maps tool arg "${argName}" from input field "${spec.from}", but that field is absent on the evaluated step input`,
      );
    }
    toolArguments[argName] = rawValue;
  }
  return { skip: false, toolArguments };
}

function toolResultErrorMessage(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null) {
    return undefined;
  }
  const record = output as Record<string, unknown>;
  if (record.isError !== true) {
    return undefined;
  }
  const content = record.content;
  if (typeof content === "string" && content.length > 0) {
    return content;
  }
  if (typeof content === "object" && content !== null) {
    const envelope = content as Record<string, unknown>;
    if (typeof envelope.error === "string" && envelope.error.length > 0) {
      return envelope.error;
    }
    return JSON.stringify(content);
  }
  return "deterministic tool step returned an error envelope";
}

export async function runDeterministicToolStep(args: {
  env: Omit<BaseEnv, "authorize">;
  toolName: string;
  input: unknown;
  /** Raw JSON of the step's `workbench.argMap` tag, if present. */
  argMapJson?: string;
  /**
   * When true (the step's `workbench.nonFatal` tag is set), a thrown tool error
   * or a tool result with `isError: true` is logged and degraded to completed
   * output instead of propagating — so one best-effort source cannot fail the
   * whole run.
   */
  nonFatal?: boolean;
  signal: AbortSignal;
}): Promise<{ output: unknown }> {
  const ctx = readStepToolContext(
    args.env as unknown as Record<string, unknown>,
  );
  const storeDir = path.dirname(args.env.workdir);

  // A deterministic tool call never runs the reactor, so no agent-level
  // `authorize` is consulted; the hub gates which packages were resolvable at
  // all via the step's pins. Supply a deny-all to complete the BaseEnv shape
  // buildStepTools' factory env spread requires.
  const stepEnv: BaseEnv = {
    ...args.env,
    authorize: async () => ({
      effect: null,
      matchingGrants: [],
      resolvedBy: null,
    }),
  };

  const { runner, disposers } = await buildStepTools({
    ctx,
    env: stepEnv,
    storage: args.env.storage,
    workdir: args.env.workdir,
  });

  try {
    const available = new Set(runner.definitions.map((d) => d.name));
    assertStepToolAvailable(args.toolName, available);
    let toolArguments: Record<string, unknown>;
    if (args.argMapJson !== undefined) {
      const reshaped = reshapeWithArgMap(
        args.toolName,
        args.input,
        args.argMapJson,
      );
      if (reshaped.skip) {
        logger.info(
          "Deterministic step {tool} skipped for {address}: {reason}",
          {
            tool: args.toolName,
            address: ctx.stepAddress,
            reason: reshaped.reason,
          },
        );
        return { output: { skipped: true } };
      }
      toolArguments = reshaped.toolArguments;
    } else {
      toolArguments = verbatimToolArguments(args.toolName, args.input);
    }
    const result = await runner.run(
      {
        id: `det-${ctx.stepAgentId}`,
        name: args.toolName,
        arguments: toolArguments,
      },
      args.signal,
    );
    const toolError = toolResultErrorMessage(result);
    if (toolError !== undefined) {
      if (args.nonFatal === true && !args.signal.aborted) {
        logger.error(
          "Deterministic step tool {tool} returned isError for {address}: {msg}",
          { tool: args.toolName, address: ctx.stepAddress, msg: toolError },
        );
        return { output: result };
      }
      if (!args.signal.aborted) {
        logger.error("Deterministic step tool {tool} failed for {address}", {
          tool: args.toolName,
          address: ctx.stepAddress,
          error: new Error(toolError),
        });
      }
      throw new Error(toolError);
    }
    return { output: result };
  } catch (cause) {
    // A degrade must never mask cancellation: if the step's signal aborted (run
    // cancel/timeout), the throw is the cancellation, not a source failure —
    // rethrow it so the runtime propagates the cancel instead of letting the
    // run march on into brief/write/persist.
    if (args.nonFatal !== true || args.signal.aborted) {
      // Log WITH the Error so the child's Sentry sink captures the stack via
      // captureException — the on-disk StepFailed event keeps only the message.
      // Skip on cancellation (signal aborted): teardown is not a fault.
      if (!args.signal.aborted) {
        logger.error("Deterministic step tool {tool} failed for {address}", {
          tool: args.toolName,
          address: ctx.stepAddress,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      }
      throw cause;
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    logger.error(
      "Deterministic step tool {tool} failed; degraded to a non-fatal skip for {address}: {msg}",
      { tool: args.toolName, address: ctx.stepAddress, msg: reason },
    );
    return {
      output: {
        content: `${args.toolName} step failed: ${reason}`,
        isError: true,
      },
    };
  } finally {
    for (const dispose of disposers) {
      try {
        await dispose();
      } catch (err) {
        logger.warn(
          "Deterministic step tool disposer failed for {address}: {msg}",
          {
            address: ctx.stepAddress,
            msg: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
    try {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        "Deterministic step store cleanup failed for {address}: {msg}",
        {
          address: ctx.stepAddress,
          msg: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
}

export interface StepAgentFactoryOpts {
  agentFactory?: <EnvReq extends BaseEnv>(
    def: AgentDefinition<EnvReq>,
    env: EnvReq,
  ) => Promise<Agent>;
  /**
   * True when this factory builds the sole agent of a WARM single-step
   * deployment (Myra/Oat/triage/gate agent), rather than a step of a genuine
   * multi-step workflow. A warm agent resolves its director from its prompt
   * markers (or its own `def.director`) and — for the personal agent — gets
   * the dynamic tool catalog + exposure wired exactly as the retired
   * in-process `default-harness` did. A multi-step step (the default, `false`)
   * keeps the budget director unconditionally and full tool advertisement.
   * Threaded from `env.spawn.warmKeep` in `workflow-substrate-factory.ts`.
   */
  warmKeep?: boolean;
}

/**
 * Construct the step agentFactory the step invoker calls as
 * `agentFactory(req.agent, env)`. `req.agent.toolFactories` are walk-only
 * stubs (synthesized at deploy time for the capability walk) that throw if
 * instantiated, so this factory ignores them: it builds the real tool
 * runner from the step's pins and substitutes its own tools factory plus a
 * grants-backed `authorize`, then delegates to `createAgent`.
 */
export function createStepAgentFactory(opts: StepAgentFactoryOpts = {}) {
  const underlying = opts.agentFactory ?? createAgent;
  return async <EnvReq extends BaseEnv>(
    def: AgentDefinition<EnvReq>,
    env: EnvReq,
  ): Promise<Agent> => {
    const ctx = readStepToolContext(env as unknown as Record<string, unknown>);

    // The env builder lays the per-step store out as
    // `<storeDir>/workspace` (workdir), so the store root is the workdir's
    // parent. It holds the per-step isogit store + workspace + any
    // re-materialized tool tarballs and is single-use per attempt; tear it
    // down when the step agent closes so disk does not grow unbounded.
    const storeDir = path.dirname(env.workdir);

    const {
      runner: baseRunner,
      packageToolNames,
      localToolNames,
      disposers,
    } = await buildStepTools({
      ctx,
      env,
      storage: env.storage,
      workdir: env.workdir,
    });

    const authorize = async (resource: string, action: string) =>
      evaluateGrants(ctx.grants, resource, action, {
        principalId: ctx.principalId,
        tenantId: ctx.tenantId,
      });

    // WORKBENCH-LOCAL: single-step (warm agent) vs multi-step (workflow step)
    // director + dynamic-tools split. Upstream's single-step-workflow launch
    // path (the runtime-retirement pin bump) routes Myra/Oat/triage/gate
    // agents through this same step factory as a warm single-step deployment.
    // Multi-step steps keep the budget director unconditionally (correct: an
    // unattended step between HITL gates needs a runaway-loop cap and never
    // opts into dynamic tools). A warm agent instead reproduces the retired
    // `default-harness` semantics: per-agent director resolution
    // (`selectDirectorId` / `def.director`) and, for the personal agent, the
    // dynamic tool catalog + persisted exposure. `warmKeep` is threaded from
    // `env.spawn.warmKeep`.
    let runner = baseRunner;
    let director: DirectorRef | undefined = {
      id: WORKFLOW_STEP_BUDGET_DIRECTOR_ID,
      config: {},
    };
    let dynamicEnv: Record<string, unknown> = {};
    // A multi-step step's prompt carries no control-plane markers, so it ships
    // to the model verbatim. A warm single-step agent's prompt does — re-home
    // the retired default-harness's marker handling below and use the cleaned,
    // active-context-appended result instead.
    let systemPrompt = def.systemPrompt;
    if (opts.warmKeep === true) {
      const resolved = await resolveWarmAgentHarness({
        def,
        runner: baseRunner,
        packageToolNames,
        localToolNames,
        authorize,
        storeDir,
        address: ctx.stepAddress,
      });
      runner = resolved.runner;
      director = resolved.director;
      dynamicEnv = resolved.dynamicEnv;

      const prepared = prepareWarmAgentPrompt(def.systemPrompt, new Date());
      systemPrompt = prepared.systemPrompt;
      if (prepared.inferenceDials !== undefined) {
        // Thread the dials via env: the marker is now stripped from the prompt,
        // and the director reads env BEFORE the (gone) prompt marker, so this
        // is how the member's dials still reach it.
        dynamicEnv = {
          ...dynamicEnv,
          [INFERENCE_PARAMS_ENV_KEY]: prepared.inferenceDials,
        };
      }
      if (prepared.seedMalformed) {
        logger.warn(
          "Seed marker for {address} resolved zero files (malformed)",
          { address: ctx.stepAddress },
        );
      }
      if (prepared.seedFiles.length > 0) {
        // Seed the agent's documented-but-not-self-created memory files into
        // its workspace. Idempotent (skips existing) and best-effort: a seed
        // failure degrades the agent's starting context but must not fail the
        // whole harness build.
        try {
          const seedResult = await seedWorkspaceFiles(env.workdir, [
            ...prepared.seedFiles,
          ]);
          logger.info(
            "Seeded {created} workspace file(s) for {address}, skipped {skipped} existing",
            {
              created: seedResult.created,
              skipped: seedResult.skipped,
              address: ctx.stepAddress,
            },
          );
        } catch (err) {
          logger.error(
            "Failed to seed workspace files for {address}: {error}",
            {
              address: ctx.stepAddress,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
    }

    const toolsFactory = defineTool({
      id: "@workbench/sidecar/step-tools",
      factory: () => ({
        definitions: runner.definitions,
        run: runner.run.bind(runner),
      }),
    });

    const stepDef = {
      id: def.id,
      systemPrompt,
      toolFactories: [toolsFactory] as const,
      capabilities: [],
      inference: { sources: [] as const },
      ...(director !== undefined ? { director } : {}),
    };

    const agentEnv = { ...env, ...dynamicEnv, authorize };
    const agent = await underlying(stepDef, agentEnv);

    const innerClose = agent.close.bind(agent);
    return {
      ...agent,
      send: agent.send.bind(agent),
      close: async () => {
        try {
          await innerClose();
        } finally {
          for (const dispose of disposers) {
            try {
              await dispose();
            } catch (err) {
              logger.warn("Step tool disposer failed for {address}: {msg}", {
                address: ctx.stepAddress,
                msg: err instanceof Error ? err.message : String(err),
              });
            }
          }
          // Reclaim the per-step store after tool disposal, on both the
          // success and failure paths. A failure to remove it is logged, not
          // thrown — close() must not surface cleanup errors.
          try {
            await fs.promises.rm(storeDir, { recursive: true, force: true });
          } catch (err) {
            logger.warn("Step store cleanup failed for {address}: {msg}", {
              address: ctx.stepAddress,
              msg: err instanceof Error ? err.message : String(err),
            });
          }
        }
      },
    };
  };
}
