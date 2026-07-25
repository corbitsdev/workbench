// Tool-capable harness for workflow STEP agents (and single agents, which
// run as single-step workflow deployments).
//
// Every deployed agent/step reads its pinned tool closure from the on-disk
// deploy tree the hub stages at deploy time: `deploy/tool-packages-manifest.json`
// + `deploy/asset-mounts.json` plus the asset tarballs under `workspace/`, at
// `<dataDir>/<sanitizeAddress(stepAddress)>/` (single agents at the head via
// `deployInstanceAtHead`; multi-step steps via `stageWorkflowStep`). This
// module loads that closure through the `@intx/tool-packaging` loader, then
// layers the workbench-specific injection AROUND the native loader: it
// resolves the tenant tool credentials the packages declare
// (`/api/internal/tools/credentials`) and builds the hub-RPC context for
// hub-backed `RuntimeCapabilities` packages (`/api/internal/hub-tools/run`),
// so a step's Granola/Gamma/Reddit/image tools authenticate and reach the hub
// exactly as before — gated by the step's persisted `agent` row and grants.
// The tool RESOLUTION is upstream's on-disk model; the credential + hub-backed
// rails are the thin layer the workbench keeps around it.

import fs from "node:fs";
import path from "node:path";
import { type } from "arktype";
import { createAgent, defineTool } from "@intx/agent";
import type { Agent, AgentDefinition, BaseEnv } from "@intx/agent";
import { evaluateGrants } from "@intx/authz";
import type { GrantRule } from "@intx/authz";
import { createHarnessRuntimeCapabilities } from "@intx/harness";
import { getLogger } from "@intx/log";
import type { MessageTransport } from "@intx/types/runtime";
import { createMailTools } from "@intx/tools-mail";
import { readDeployTree } from "@workbench/hub-agent";
import {
  HUB_RPC_ENV_KEY,
  providerFromEnvKey,
} from "@workbench/tool-credentials";
import {
  ArgMap,
  WORKFLOW_STEP_BUDGET_DIRECTOR_ID,
  DYNAMIC_TOOLS_DIRECTOR_ID,
  TRIAGE_BUDGET_DIRECTOR_ID,
  INVOKE_BUDGET_DIRECTOR_ID,
  resolveDynamicToolConfig,
  toLlmToolName,
} from "@workbench/agents";
import {
  isTriageSessionPrompt,
  isInvokeSessionPrompt,
  resolveSeedMarker,
  stripSeedMarker,
  resolveInferenceParamsMarker,
  stripInferenceParamsMarker,
  stripPersonalAgentIdentityMarker,
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
 * A step declared a tool whose owning tool-package factory materialized but
 * threw `ToolCredentialMissingError` at construction time — the tenant has no
 * credential configured for the provider the tool requires. Distinct from
 * {@link StepToolNotRegisteredError}: the tool WAS pinned and its package DID
 * resolve, it was dropped for a missing tenant credential, so "not pinned" is
 * false and misleading. Named + carries the provider so the run-failure detail
 * tells an operator exactly which credential to configure.
 */
export class StepToolCredentialMissingError extends Error {
  readonly toolName: string;
  readonly providerName: string;
  constructor(toolName: string, providerName: string) {
    super(
      `tool "${toolName}" requires a credential for provider "${providerName}" ` +
        `that is not configured for this tenant; configure a "${providerName}" ` +
        `credential before this step can run`,
    );
    this.name = "StepToolCredentialMissingError";
    this.toolName = toolName;
    this.providerName = providerName;
  }
}

/**
 * A tool-package factory `buildStepTools` skipped because it threw
 * `ToolCredentialMissingError` — recorded so a later `assertStepToolAvailable`
 * call can tell a genuinely-unpinned tool apart from one dropped for a
 * missing credential. `factoryId` is the loader's canonical factory id (the
 * prefix of every `<factoryId>:<name>` tool the factory would have defined).
 */
export interface CredentialSkippedFactory {
  readonly factoryId: string;
  readonly providerName: string;
}

/**
 * Throw a clear, named error when a step's declared tool is absent from the
 * tools that actually loaded for the step. When the tool's owning factory was
 * skipped for a missing tenant credential (`credentialSkips`), throws the
 * credential-specific {@link StepToolCredentialMissingError} instead of the
 * generic, misleading "not pinned" {@link StepToolNotRegisteredError}.
 */
export function assertStepToolAvailable(
  toolName: string,
  available: ReadonlySet<string>,
  credentialSkips: readonly CredentialSkippedFactory[] = [],
): void {
  if (available.has(toolName)) return;
  const skip = credentialSkips.find((s) =>
    toolName.startsWith(`${s.factoryId}:`),
  );
  if (skip !== undefined) {
    throw new StepToolCredentialMissingError(toolName, skip.providerName);
  }
  throw new StepToolNotRegisteredError(toolName, [...available]);
}

/**
 * Faults that indicate the step's tool infrastructure itself is broken or
 * misconfigured — the tool was never pinned, its credential is missing, or
 * its loaded closure is corrupt — as opposed to the tool running and failing
 * on its own terms (a data/execution fault). A caller that only wants to
 * degrade genuine tool-execution failures (e.g. a wrapper's own tolerance
 * envelope) must not treat one of these as such: an infrastructure fault
 * means the step never actually attempted the work.
 */
export function isStepToolInfrastructureFault(error: unknown): boolean {
  return (
    error instanceof StepToolNotRegisteredError ||
    error instanceof StepToolCredentialMissingError ||
    error instanceof StepToolFactoryAbsentError
  );
}

/**
 * A loaded tool-package entry carried a null/absent factory (or a factory
 * missing its `id`/`requires` metadata). The `@intx/tool-packaging` loader
 * never produces such an entry, so hitting this is a real integrity fault in
 * the on-disk deploy tree or a wiring break — surfaced with the offending
 * package + address instead of the opaque `null is not an object (evaluating
 * 'factory.id')` NPE the raw loop would throw when it dereferences the absent
 * factory. Fail loud, never silently ship an agent with fewer tools than it
 * pinned.
 */
export class StepToolFactoryAbsentError extends Error {
  readonly packageName: string;
  readonly address: string;
  constructor(packageName: string, address: string) {
    super(
      `tool package "${packageName}" resolved a null/absent factory for ${address}; ` +
        `the deploy tree's pinned tool closure is corrupt or mis-materialized`,
    );
    this.name = "StepToolFactoryAbsentError";
    this.packageName = packageName;
    this.address = address;
  }
}

/**
 * Guard a loaded package's factory before its `id`/`requires` metadata is
 * dereferenced. The loader guarantees non-null, id/requires-bearing factories;
 * this is the fail-loud backstop for a corrupt closure that would otherwise
 * crash the workflow child with an opaque `factory.id` NPE before it emits
 * ready.
 */
export function assertLoadedFactory(
  factory: unknown,
  packageName: string,
  address: string,
): asserts factory is { id: string; requires: readonly string[] } {
  if (
    factory === null ||
    (typeof factory !== "function" && typeof factory !== "object") ||
    typeof (factory as { id?: unknown }).id !== "string" ||
    !Array.isArray((factory as { requires?: unknown }).requires)
  ) {
    throw new StepToolFactoryAbsentError(packageName, address);
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
  /**
   * On-disk deploy-tree directory for this step
   * (`<dataDir>/<sanitizeAddress(stepAddress)>`). The hub stages
   * `deploy/tool-packages-manifest.json` + `deploy/asset-mounts.json` here at
   * deploy time (single agents at the head via `deployInstanceAtHead`,
   * multi-step steps via `stageWorkflowStep`), and the asset tarballs under
   * `<deployTreeDir>/workspace/`. The step harness reads its pinned tool
   * closure straight off this tree — the on-disk model, replacing the retired
   * hub-RPC `/api/internal/tools/manifest` fetch.
   */
  deployTreeDir: string;
  cacheRoot: string;
  cacheMaxBytes: number;
  registryMaxTarballBytes: number;
}

export const STEP_TOOL_CONTEXT_KEY = "workbench.stepToolContext";

/**
 * Read the step's pinned tool-package manifest + asset-mounts from the
 * on-disk deploy tree the hub staged at deploy time. The tarballs are
 * already staged under `<deployTreeDir>/workspace/<mount>/<path>` (the hub's
 * asset-pack push), so the loader's `assetMounts` map resolves against that
 * workspace directly — no re-materialization from the wire.
 *
 * A deploy with no tool-package manifest yields `rawManifestBytes:
 * undefined` (the legitimate no-native-tools case); the step then runs with
 * local tools only. A present-but-corrupt manifest surfaces loudly through
 * `loadToolPackages` (the JSON/schema throw path), never a silent empty-tools
 * fallback that would mask a broken deploy.
 */
export async function readStepDeployTree(args: {
  ctx: StepToolContext;
}): Promise<{
  rawManifestBytes: string | undefined;
  assetMounts: ReadonlyMap<string, string>;
}> {
  const tree = await readDeployTree(args.ctx.deployTreeDir);
  return {
    rawManifestBytes: tree.toolPackageManifestRaw,
    assetMounts: tree.assetMounts,
  };
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
 * and (when `env.transport` is present) local mail tools for deterministic
 * `mail_send` steps. Package tools only — no free local POSIX inject.
 * Returns the runner plus the disposers the agent lifetime must run.
 */
async function buildStepTools(args: {
  ctx: StepToolContext;
  env: BaseEnv;
  workdir: string;
}): Promise<{
  runner: DefinedRunner;
  loadedToolNames: Set<string>;
  /**
   * Native tool-package tool names only (mail excluded). These are the
   * catalog-gated candidates: the warm single-step path admits them through
   * the dispatch allow-list only when the member is granted them.
   */
  packageToolNames: Set<string>;
  /**
   * Factories dropped because their tenant-scoped credential is missing —
   * threaded to `assertStepToolAvailable` so a deterministic step's dispatch
   * failure names the missing credential instead of reporting the tool as
   * unpinned.
   */
  credentialSkips: CredentialSkippedFactory[];
  disposers: (() => Promise<void>)[];
}> {
  const { ctx } = args;
  const storeDir = path.dirname(args.workdir);

  const manifestStart = performance.now();
  const { rawManifestBytes, assetMounts } = await readStepDeployTree({ ctx });
  const manifestMs = performance.now() - manifestStart;

  const loadStart = performance.now();
  const loadedPackages = await loadToolPackages({
    rawManifestBytes,
    assetMounts,
    storeDir,
    agentAddress: ctx.stepAddress,
    // The hub staged the asset tarballs under the deploy tree's own
    // workspace; point the loader there while keeping the apply-state +
    // tarball cache rooted per step under `storeDir` (upstream's
    // `materializeToolPackages` layout).
    assetRoot: path.join(ctx.deployTreeDir, "workspace"),
    cacheRoot: ctx.cacheRoot,
    cacheMaxBytes: ctx.cacheMaxBytes,
    registryMaxTarballBytes: ctx.registryMaxTarballBytes,
  });
  const loadMs = performance.now() - loadStart;

  const requiredProviders = new Set<string>();
  for (const pkg of loadedPackages) {
    for (const factory of pkg.factories) {
      assertLoadedFactory(factory, pkg.name, ctx.stepAddress);
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

  // The factory env is the agent env plus the credential + hub-RPC keys the
  // tool-package factories declare via `requires`.
  const factoryEnv = {
    ...args.env,
    ...credentialEnv,
    [HUB_RPC_ENV_KEY]: hubRpcContext,
  };

  const loadedRunners: DefinedRunner[] = [];
  const disposers: (() => Promise<void>)[] = [];
  const loadedToolNames = new Set<string>();
  const packageToolNames = new Set<string>();
  const credentialSkips: CredentialSkippedFactory[] = [];
  for (const pkg of loadedPackages) {
    for (const factory of pkg.factories) {
      assertLoadedFactory(factory, pkg.name, ctx.stepAddress);
      let bundle: ReturnType<typeof factory>;
      try {
        bundle = factory(factoryEnv);
      } catch (err) {
        // Tool packages load from published tarballs, so this may be a
        // different bundle copy of ToolCredentialMissingError than the one
        // in this process — `instanceof` can miss across bundles. `err.name`
        // survives bundling, so match on it instead.
        if (err instanceof Error && err.name === "ToolCredentialMissingError") {
          const providerName = (err as { providerName?: string }).providerName;
          // A missing tenant credential silently dropped this package from
          // the step's runner: a later dispatch to one of its tools must fail
          // with a credential-specific error, not the misleading "not
          // pinned" StepToolNotRegisteredError, so log at error — this is an
          // actionable operator-facing fault, not routine info.
          logger.error(
            "Tool package {id} skipped for {address}: no credential configured for provider {providerName}",
            {
              id: factory.id,
              address: ctx.stepAddress,
              providerName,
            },
          );
          if (providerName !== undefined) {
            credentialSkips.push({ factoryId: factory.id, providerName });
          }
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
      // Keep definitions in the tool-packaging loader's canonical
      // `<factoryId>:<name>` form here (e.g. `@workbench/tools-exa/exa:exa_search`).
      // `buildStepTools` is shared by two consumers with DIFFERENT name
      // contracts: `runDeterministicToolStep` dispatches by the canonical
      // colon-form name a deterministic workflow step declares
      // (`deterministicToolStep`'s `STEP_TOOL_TAG`, threaded through
      // `workflow-substrate-factory.ts`'s `runDeterministicToolStep` call),
      // while the warm single-step agent path needs the LLM-safe
      // `toLlmToolName` alias the model can actually call (CL-2306) and the
      // dynamic tool catalog advertises (CL-3929). Renaming here would break
      // every deterministic package-tool step. The warm-agent-only alias
      // projection is applied in `resolveWarmAgentHarness`, the one
      // model-facing consumer that needs it.
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

  const runners: DefinedRunner[] = [...loadedRunners];

  // The workflow substrate injects an in-process mail transport on the step
  // env (env.transport) whenever the deployment has a mailbox. Mail is a
  // local runner, never a pinned package, so it must be merged here for a
  // deterministic `mail_send` step to resolve. Guard on presence:
  // pure-inference deployments and test seams inject no transport and get no
  // mail tools. The warm single-step path constructs mail the same way but
  // does not advertise `mail_*` to the model (see resolveWarmAgentHarness).
  // The env value is constructed in-process by the substrate this same run
  // and never crosses a trust boundary, so a plain narrowing cast is sound
  // (same reasoning as readStepToolContext).
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
    }
  }

  // Steps expose every materialized native package tool (plus mail when
  // transport is present). The grants-backed `authorize` the factory installs
  // is the real per-call gate, and the hub gates which packages were
  // resolvable at all via the step's pins. No name-filter is applied here —
  // it would be a no-op (every loaded tool name is already in the merged set).
  const merged = mergeToolRunners(runners) as DefinedRunner;
  return {
    runner: merged,
    loadedToolNames,
    packageToolNames,
    credentialSkips,
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
 * This resolves all three markers, strips them (plus the personal-agent
 * identity marker), and appends a fresh active-context block. Crucially it
 * returns the dials to thread via ENV rather than leaving them on the prompt:
 * `readInferenceParamsForDirector` reads env BEFORE the prompt marker, so once
 * the marker is stripped the director must get the dials from env or the
 * member's dials are silently lost. Pure so the marker/strip/active-context
 * contract is unit-testable without a harness.
 */
export function prepareWarmAgentPrompt(
  rawSystemPrompt: string,
  now: Date,
): PreparedWarmAgentPrompt {
  const seed = resolveSeedMarker(rawSystemPrompt);
  const timeZone = resolveTimeZoneMarker(rawSystemPrompt);
  const inferenceDials = resolveInferenceParamsMarker(rawSystemPrompt);
  const cleaned = stripPersonalAgentIdentityMarker(
    stripInferenceParamsMarker(
      stripTimeZoneMarker(stripSeedMarker(rawSystemPrompt)),
    ),
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
 * Present each PACKAGE tool's canonical `<factoryId>:<name>` definition to
 * the model under its LLM-safe `toLlmToolName` alias (e.g.
 * `@workbench/tools-exa/exa:exa_search` -> `exa__search`), and translate a
 * dispatched call back to the canonical name before it reaches the
 * underlying runner. That string carries `@`, `/`, and `:`, which violate
 * LLM function-name constraints and do not round-trip (kimi truncates at the
 * `:`, CL-2306) — so the model's tool call would never match its grant or
 * the loader's own dispatch entry — and the dynamic tool catalog
 * (`packages/agent-core/src/dynamic-tools-catalog.ts`) advertises tools in
 * this same alias form, so `load_tools`/`search_tools` need it to recognize a
 * successfully-loaded, credentialed, granted package tool (CL-3929).
 *
 * WORKBENCH-LOCAL: applied to every MODEL-FACING agent this factory builds —
 * both the warm single-step agent and a genuine multi-step workflow step.
 * Every reasoning step hands its tool definitions to a provider exactly like
 * a warm agent does, so an over-length or symbol-bearing canonical name
 * (`@`, `/`, `:`) blows the same 64-char/charset provider limit there. Only
 * `buildStepTools`'s OWN return value (its `definitions`/`packageToolNames`,
 * consumed directly by `runDeterministicToolStep`) stays canonical — that
 * dispatches by the colon-form name a deterministic workflow step declares
 * (`deterministicToolStep`'s `STEP_TOOL_TAG`), and aliasing there would throw
 * `StepToolNotRegisteredError` on every deterministic package-tool step. The
 * alias projection happens only on the copy handed to `createAgent` in
 * `createStepAgentFactory`, so both consumers of `buildStepTools` keep their
 * own contract. Local mail tools are already unprefixed (not in
 * `packageToolNames`) and pass through unchanged here; warm advertisement
 * strips them separately.
 *
 * Two distinct canonical names that happen to collide on the same alias
 * (a package/tool-name combination degenerate enough to produce the same
 * `<pkgShort>__<tool>`) would otherwise silently shadow one another via
 * last-write-wins `Map.set`; log it loudly instead so a real collision is a
 * visible operational signal rather than one tool quietly vanishing.
 */
function applyLlmSafeAliases(
  runner: DefinedRunner,
  packageToolNames: ReadonlySet<string>,
  address: string,
): { runner: DefinedRunner; packageToolNames: Set<string> } {
  const aliasToCanonical = new Map<string, string>();
  const safePackageToolNames = new Set<string>();
  const definitions = runner.definitions.map((def) => {
    if (!packageToolNames.has(def.name)) return def;
    const safe = toLlmToolName(def.name);
    const collision = aliasToCanonical.get(safe);
    if (collision !== undefined && collision !== def.name) {
      logger.error(
        "LLM-safe tool name collision for {address}: canonical names {a} and {b} both alias to {safe}; {b} shadows {a}",
        { address, a: collision, b: def.name, safe },
      );
    }
    aliasToCanonical.set(safe, def.name);
    safePackageToolNames.add(safe);
    return { ...def, name: safe };
  });
  return {
    runner: {
      definitions,
      run: (call, signal) =>
        runner.run(
          { ...call, name: aliasToCanonical.get(call.name) ?? call.name },
          signal,
        ),
    },
    packageToolNames: safePackageToolNames,
  };
}

/**
 * Warm single-step agents must not advertise `mail_*` tools to the model even
 * when `buildStepTools` constructed them for a present transport (det
 * `mail_send` still resolves by name on the unfiltered runner). Strip mail
 * definitions from the warm advertisement surface only.
 */
function stripMailFromWarmAdvertisement(runner: DefinedRunner): DefinedRunner {
  const definitions = runner.definitions.filter(
    (d) => !d.name.startsWith("mail_"),
  );
  if (definitions.length === runner.definitions.length) return runner;
  return {
    definitions,
    run: (call, signal) => runner.run(call, signal),
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
 *
 * WORKBENCH-LOCAL: `args.runner`/`args.packageToolNames` are expected
 * ALREADY LLM-safe-aliased — `createStepAgentFactory` now applies
 * `applyLlmSafeAliases` once, ahead of the warm/multi-step branch, so both
 * paths present the same alias form to the model without double-aliasing.
 */
async function resolveWarmAgentHarness(args: {
  def: { systemPrompt: string; director?: DirectorRef };
  runner: DefinedRunner;
  packageToolNames: ReadonlySet<string>;
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
  // Mail may still sit on the underlying runner for det bookkeeping, but warm
  // never advertises `mail_*` names (or any free local inject) to the model.
  const runner = stripMailFromWarmAdvertisement(args.runner);
  const packageToolNames = args.packageToolNames;
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
    // No dynamic catalog: full package advertisement, no allow-list gate —
    // identical to the retired harness's `grantedCatalogToolNames === undefined`
    // path. Mail already stripped above so even this early return stays clean.
    return { runner, director, dynamicEnv: {} };
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
    // `ask` is a grant, not a denial: the tool is authorized and merely
    // suspends for human approval at invoke time (CL-3934 native-approvals). It
    // must stay in the catalog, or a write tool would vanish the moment its
    // grant flips from allow to ask.
    if (decision.effect === "allow" || decision.effect === "ask") {
      grantedCatalogToolNames.add(name);
    }
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
  ).filter((name) => packageToolNames.has(name));
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
    availableToolNames: packageToolNames,
    onExposureChanged: (exposed) => {
      void persistExposure(storeDir, exposed).catch((err: unknown) => {
        logger.error("Failed to persist tool exposure for {address}: {error}", {
          address,
          error: String(err),
        });
      });
    },
  }) as DefinedRunner;

  // Loaded package tools are gated on `grantedCatalogToolNames`; the catalog
  // control tools (search_tools/load_tools) are always allowed (CL-3848
  // admission). No free local inject (posix gone; mail is not advertised on
  // warm — stripMailFromWarmAdvertisement already dropped those definitions).
  const allowedNames = buildDispatchAllowedToolNames(
    [],
    packageToolNames,
    catalogRunner.definitions.map((d) => d.name),
    grantedCatalogToolNames,
  );
  const merged = mergeToolRunners([runner, catalogRunner]) as DefinedRunner;
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
 * `argMap`. A `skip` result means a `skipStepIfAbsent` field was absent (or
 * an empty string) on the evaluated input — the caller must not invoke the
 * tool at all, and must not treat this as an error. An absent/empty
 * `optional` field is NOT a skip: it is simply omitted from
 * `toolArguments`, and the tool call still proceeds.
 */
export type ArgMapReshapeResult =
  | { skip: true; reason: string }
  | { skip: false; toolArguments: Record<string, unknown> };

/**
 * Reshape the evaluated step input into tool arguments per the step's
 * `argMap`. The argMap JSON is parsed + validated through arktype at this
 * trust boundary. For each `[argName, spec]`: `{ from }` pulls a top-level
 * field off the evaluated input. Non-optional, non-skip `{ from }`: absence
 * is a missing key on the evaluated step input and fails loud, naming it —
 * an empty string is a real value and passes through unchanged. Optional
 * `{ from, optional: true }`: an absent key OR an empty-string value OMITS
 * `argName` from the returned `toolArguments` — the tool is still called,
 * just without that one argument. `{ from, skipStepIfAbsent: true }`: an
 * absent key OR an empty-string value skips the tool call entirely — for the
 * rare argMap whose field is the tool's own only required argument, where
 * there is no sensible "call without it". `{ literal }` supplies the
 * constant. `{ fromJson, field }` reads `fromJson` off the input,
 * JSON-parses it when it is a string (an already-object value is
 * tolerated), then applies the same presence/optional/skipStepIfAbsent
 * rules to `field` on the parsed object — for a deterministic step
 * consuming another deterministic tool's `stringTool` output (encoded as
 * `{ content: "<json>" }`).
 */
export function reshapeWithArgMap(
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
    if ("object" in spec) {
      const objectArgument: Record<string, unknown> = {};
      for (const [fieldName, fieldSpec] of Object.entries(spec.object)) {
        if ("literal" in fieldSpec) {
          objectArgument[fieldName] = fieldSpec.literal;
          continue;
        }
        if ("fromJson" in fieldSpec) {
          const envelope =
            inputRecord !== undefined && fieldSpec.fromJson in inputRecord
              ? inputRecord[fieldSpec.fromJson]
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
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : undefined;
          const present =
            parsedRecord !== undefined && fieldSpec.field in parsedRecord;
          const value = present ? parsedRecord[fieldSpec.field] : undefined;
          const isAbsentOrEmpty = !present || value === "";
          if (isAbsentOrEmpty && fieldSpec.skipStepIfAbsent === true) {
            return {
              skip: true,
              reason: `object field "${fieldName}" is absent or empty and skipStepIfAbsent is set`,
            };
          }
          if (isAbsentOrEmpty && fieldSpec.optional === true) {
            continue;
          }
          if (!present) {
            throw new Error(
              `step-tool-harness: deterministic step "${toolName}" argMap maps object field "${fieldName}" from JSON field "${fieldSpec.field}" of input field "${fieldSpec.fromJson}", but that field is absent on the evaluated step input`,
            );
          }
          objectArgument[fieldName] = value;
          continue;
        }
        const present =
          inputRecord !== undefined && fieldSpec.from in inputRecord;
        const value = present ? inputRecord[fieldSpec.from] : undefined;
        const isAbsentOrEmpty = !present || value === "";
        if (isAbsentOrEmpty && fieldSpec.skipStepIfAbsent === true) {
          return {
            skip: true,
            reason: `object field "${fieldName}" is absent or empty and skipStepIfAbsent is set`,
          };
        }
        if (isAbsentOrEmpty && fieldSpec.optional === true) {
          continue;
        }
        if (!present) {
          throw new Error(
            `step-tool-harness: deterministic step "${toolName}" argMap maps object field "${fieldName}" from input field "${fieldSpec.from}", but that field is absent on the evaluated step input`,
          );
        }
        objectArgument[fieldName] = value;
      }
      toolArguments[argName] = objectArgument;
      continue;
    }
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
      const isEmptyString = typeof fieldValue === "string" && fieldValue === "";
      const isAbsentOrEmpty = !fieldPresent || isEmptyString;
      if (isAbsentOrEmpty && spec.skipStepIfAbsent === true) {
        return {
          skip: true,
          reason: `deterministic step "${toolName}" argMap maps tool arg "${argName}" from JSON field "${spec.field}" of "${spec.fromJson}", which is absent or empty on the evaluated step input and skipStepIfAbsent is set`,
        };
      }
      if (isAbsentOrEmpty && spec.optional === true) {
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
    const isEmptyString = typeof rawValue === "string" && rawValue === "";
    const isAbsentOrEmpty = !present || isEmptyString;
    if (isAbsentOrEmpty && spec.skipStepIfAbsent === true) {
      return {
        skip: true,
        reason: `deterministic step "${toolName}" argMap maps tool arg "${argName}" from input field "${spec.from}", which is absent or empty on the evaluated step input and skipStepIfAbsent is set`,
      };
    }
    if (isAbsentOrEmpty && spec.optional === true) {
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

/**
 * Eagerly validate that `toolName` resolves against a step's pinned tool
 * packages + tenant credentials — load the packages, resolve credentials,
 * assert the tool is present, then dispose immediately without invoking it.
 * Throws the same `isStepToolInfrastructureFault` family
 * `runDeterministicToolStep` raises (`StepToolNotRegisteredError` /
 * `StepToolCredentialMissingError` / `StepToolFactoryAbsentError`).
 *
 * Used by the action-handler registry (`action-tool-handler.ts`) to fail an
 * unresolvable action `handler` ref AT DEPLOYMENT ESTABLISH — a missing tool
 * package or an unconfigured tenant credential surfaces immediately, in
 * front of whoever is watching the deploy, instead of silently succeeding
 * until the action is first dispatched deep into an unattended run.
 */
export async function assertStepToolResolvable(args: {
  env: Omit<BaseEnv, "authorize">;
  toolName: string;
}): Promise<void> {
  const ctx = readStepToolContext(
    args.env as unknown as Record<string, unknown>,
  );
  const stepEnv: BaseEnv = {
    ...args.env,
    authorize: async () => ({
      effect: null,
      matchingGrants: [],
      resolvedBy: null,
    }),
  };
  const { runner, disposers, credentialSkips } = await buildStepTools({
    ctx,
    env: stepEnv,
    workdir: args.env.workdir,
  });
  try {
    const available = new Set(runner.definitions.map((d) => d.name));
    assertStepToolAvailable(args.toolName, available, credentialSkips);
  } finally {
    for (const dispose of disposers) {
      try {
        await dispose();
      } catch (err) {
        logger.warn(
          "assertStepToolResolvable: disposer failed for {tool} at {address}: {msg}",
          {
            tool: args.toolName,
            address: ctx.stepAddress,
            msg: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
  }
}

export async function runDeterministicToolStep(args: {
  env: Omit<BaseEnv, "authorize">;
  toolName: string;
  input: unknown;
  /** Raw JSON of the step's `workbench.argMap` tag, if present. */
  argMapJson?: string;
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

  const { runner, disposers, credentialSkips } = await buildStepTools({
    ctx,
    env: stepEnv,
    workdir: args.env.workdir,
  });

  try {
    const available = new Set(runner.definitions.map((d) => d.name));
    assertStepToolAvailable(args.toolName, available, credentialSkips);
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
    // No `nonFatal` degrade exists on this path anymore (CL-4464 replaced
    // every best-effort deterministic step with a workflow-owned tolerance-
    // envelope wrapper — see `@workbench/tool-credentials/tolerance-
    // envelope-dispatch`). Every failure here rethrows: a genuine
    // tool-execution error, a run cancel/timeout (signal aborted), or an
    // infrastructure fault (`isStepToolInfrastructureFault` — unpinned tool,
    // missing credential, corrupt closure) all propagate identically. Log
    // WITH the Error so the child's Sentry sink captures the stack via
    // captureException — the on-disk StepFailed event keeps only the
    // message. Skip logging on cancellation (signal aborted): teardown is
    // not a fault.
    if (!args.signal.aborted) {
      logger.error("Deterministic step tool {tool} failed for {address}", {
        tool: args.toolName,
        address: ctx.stepAddress,
        error: cause instanceof Error ? cause : new Error(String(cause)),
      });
    }
    throw cause;
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
      disposers,
    } = await buildStepTools({
      ctx,
      env,
      workdir: env.workdir,
    });

    const authorize = async (resource: string, action: string) =>
      evaluateGrants(ctx.grants, resource, action, {
        principalId: ctx.principalId,
        tenantId: ctx.tenantId,
      });

    // WORKBENCH-LOCAL: project every package tool's canonical
    // `<factoryId>:<name>` definition to its LLM-safe alias BEFORE the
    // warm/multi-step branch below — this is the one place `createAgent`
    // (the model-facing consumer) is built for either kind of step agent, so
    // both get the same provider-safe tool names and the same canonical
    // dispatch translation. `buildStepTools`'s own return value stays
    // canonical for `runDeterministicToolStep`'s separate, unaliased
    // dispatch contract (see `applyLlmSafeAliases`'s docstring).
    const aliased = applyLlmSafeAliases(
      baseRunner,
      packageToolNames,
      ctx.stepAddress,
    );

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
    let runner = aliased.runner;
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
        runner: aliased.runner,
        packageToolNames: aliased.packageToolNames,
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
