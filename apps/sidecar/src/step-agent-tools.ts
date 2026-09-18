// The child IS the sidecar binary, so its tool runtime is present in the
// child's address space; this module runs it when the real step-invoker
// builds a step's agent. Wrapping close() to run plugin/bundle disposers
// is what guarantees the LSP subprocess dies with the step's agent on
// every exit path. Lives in apps/sidecar so @intx/workflow-host stays
// free of the tool runtime dependency.

import path from "node:path";

import {
  createAgent,
  defineAgent,
  defineTool,
  toolApprovalEffect,
  type Agent,
  type AgentDefinition,
  type AnnotatedPluginFactory,
  type AnnotatedToolFactory,
  type BaseEnv,
  type ToolBundle,
} from "@intx/agent";
import { readDeployTree, agentDir } from "@intx/hub-agent/paths";
import { getLogger } from "@intx/log";
import type { HostCredentialCapability } from "@intx/harness";
import type { LoadedToolFactory } from "@intx/tool-packaging";
import { resolveStepAddress } from "@intx/workflow-deploy";
import { parseRunAddress } from "@intx/types";
import type { GrantRule } from "@intx/types/authz";
import {
  layerRuntimeCapabilities,
  type RuntimeCapabilities,
} from "@intx/types/runtime-capabilities";
import { baseStepId } from "@intx/workflow";

import {
  buildCredentialCapabilities,
  type StepCredentialWiring,
} from "./step-credential-capabilities";
import { materializeToolPackages, type StepToolFactory } from "./tool-materialization";

const logger = getLogger(["sidecar", "workflow-child", "step-tools"]);

/** Resolved at the boot edge and threaded into the child so per-step materialization stays bounded. */
export interface StepToolCacheConfig {
  readonly cacheMaxBytes: number;
  readonly registryMaxTarballBytes: number;
}

/** Carried via a symbol-keyed slot on the per-step env so the two step-invoker callbacks cooperate without widening its surface. */
export interface StepToolMaterialization {
  readonly factories: readonly StepToolFactory[];
  readonly pluginFactories: readonly AnnotatedPluginFactory[];
}

/**
 * The hub's capability walk only reads inline agent.toolFactories, so a
 * pinned-package tool never gets a hub-side tool:<name> grant; these
 * derived rows supply that floor as additional grants, which an explicit
 * deny still overrides by evaluateGrants precedence. The id is
 * deterministic (floor:tool:<name>) since evaluateGrants doesn't dedupe by id.
 */
export function deriveToolMarkFloorGrants(factories: readonly LoadedToolFactory[]): GrantRule[] {
  const rows: GrantRule[] = [];
  for (const factory of factories) {
    for (const definition of factory.definitions) {
      rows.push({
        id: `floor:tool:${definition.name}`,
        resource: `tool:${definition.name}`,
        action: "invoke",
        effect: toolApprovalEffect(definition),
        origin: "creator",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: null,
      });
    }
  }
  return rows;
}

// Symbol survives the step-invoker adapter's `{ ...envBase, authorize }`
// spread, which copies own enumerable symbol-keyed properties.
const STEP_TOOLS = Symbol("intx.sidecar.step-tools");

// Read/written via Reflect since BaseEnv has no symbol index signature.
function setStepToolSlot(env: object, materialization: StepToolMaterialization): void {
  Reflect.set(env, STEP_TOOLS, materialization);
}

function getStepToolSlot(env: object): StepToolMaterialization | undefined {
  const value: unknown = Reflect.get(env, STEP_TOOLS);
  if (value === undefined) return undefined;
  if (!isStepToolMaterialization(value)) {
    throw new Error(
      "sidecar workflow-child step tools: the per-step env's tool slot is not a StepToolMaterialization; the slot is private to this module and must only be set by attachStepTools",
    );
  }
  return value;
}

function isStepToolMaterialization(value: unknown): value is StepToolMaterialization {
  return (
    typeof value === "object" &&
    value !== null &&
    "factories" in value &&
    "pluginFactories" in value &&
    Array.isArray(value.factories) &&
    Array.isArray(value.pluginFactories)
  );
}

/** Absent for a build with no credential context (e.g. a unit test), in which case bundles keep the base bag. */
const STEP_CREDENTIAL_WIRING = Symbol("intx.sidecar.step-credential-wiring");

function setStepCredentialWiring(env: object, wiring: StepCredentialWiring): void {
  Reflect.set(env, STEP_CREDENTIAL_WIRING, wiring);
}

function getStepCredentialWiring(env: object): StepCredentialWiring | undefined {
  const value: unknown = Reflect.get(env, STEP_CREDENTIAL_WIRING);
  if (value === undefined) return undefined;
  if (!isStepCredentialWiring(value)) {
    throw new Error(
      "sidecar workflow-child step tools: the per-step env's credential-wiring slot is not a StepCredentialWiring; the slot is private to this module and must only be set by attachStepCredentialWiring",
    );
  }
  return value;
}

function isStepCredentialWiring(value: unknown): value is StepCredentialWiring {
  return (
    typeof value === "object" &&
    value !== null &&
    "materialCell" in value &&
    "resolveGrants" in value &&
    "providers" in value
  );
}

/** Omitted for a build with no credential context, leaving the slot unset. */
export function attachStepCredentialWiring(
  env: Omit<BaseEnv, "authorize">,
  wiring: StepCredentialWiring,
): void {
  setStepCredentialWiring(env, wiring);
}

/** Throws on a missing base bag: that's a wiring inconsistency (buildEnv sets both), not to paper over. */
function requireCapabilitiesBag(env: BaseEnv): RuntimeCapabilities {
  const value: unknown = Reflect.get(env, "capabilities");
  if (
    typeof value !== "object" ||
    value === null ||
    !("resolve" in value) ||
    typeof (value as { resolve: unknown }).resolve !== "function"
  ) {
    throw new Error(
      "sidecar workflow-child step tools: a credentials capability was assembled for this bundle but the per-step env carries no base capabilities bag to layer it onto; buildEnv must set env.capabilities before assembling credentials",
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated structurally above: an object whose `resolve` is callable is the RuntimeCapabilities resolver buildEnv set
  return value as RuntimeCapabilities;
}

/**
 * The deploy tree lands in the legacy per-agent directory keyed by the
 * step's mail address, not the substrate's agent-state/<id> layout — the
 * multi-step deploy path never pushes step agent-state packs there.
 */
export function stepDeployTreeDir(args: {
  dataDir: string;
  mailboxAddress: string;
  stepId: string;
  stepCount: number;
}): string {
  const parsed = parseRunAddress(args.mailboxAddress);
  if (parsed === null) {
    throw new Error(
      `sidecar workflow-child step tools: deployment mailbox address ${JSON.stringify(args.mailboxAddress)} is not a parseable run address; cannot locate the step's deploy tree`,
    );
  }
  // A map iteration's scoped step id resolves to its base address, since
  // deploy stages one tree per base step; baseStepId is identity otherwise.
  const stepAddress = resolveStepAddress({
    runId: parsed.runId,
    stepId: baseStepId(args.stepId),
    domain: parsed.domain,
    stepCount: args.stepCount,
  });
  return agentDir(args.dataDir, stepAddress);
}

/** Rooted under storeDir so concurrent steps in one child never collide on cache/apply-state paths. */
export async function materializeStepTools(args: {
  dataDir: string;
  mailboxAddress: string;
  stepId: string;
  stepCount: number;
  /** Per-step state root; cache + instance dir + workspace live under it. */
  storeDir: string;
  cache: StepToolCacheConfig;
}): Promise<StepToolMaterialization> {
  const deployTreeDir = stepDeployTreeDir({
    dataDir: args.dataDir,
    mailboxAddress: args.mailboxAddress,
    stepId: args.stepId,
    stepCount: args.stepCount,
  });
  const deployTree = await readDeployTree(deployTreeDir);

  // Per-step even though content-addressed, so a wedged apply in one step
  // cannot corrupt another's view.
  const cacheRoot = path.join(args.storeDir, "tarball-cache");

  // deployTreeDir/workspace (read-only, keyed by base step) and
  // storeDir/workspace (read-write, keyed by scoped step) share a leaf name
  // but are deliberately different roots — a map iteration reads one shared
  // tree while each iteration writes its own scratch. Do not unify them.
  const assetRoot = path.join(deployTreeDir, "workspace");

  const materialized = await materializeToolPackages({
    rawManifestBytes: deployTree.toolPackageManifestRaw,
    assetMounts: deployTree.assetMounts,
    storeDir: args.storeDir,
    assetRoot,
    agentAddress: args.mailboxAddress,
    cacheRoot,
    cacheMaxBytes: args.cache.cacheMaxBytes,
    registryMaxTarballBytes: args.cache.registryMaxTarballBytes,
  });
  return {
    factories: materialized.factories,
    pluginFactories: materialized.pluginFactories,
  };
}

/** Omit<BaseEnv, "authorize"> because buildEnv yields exactly that shape before the adapter adds authorize. */
export function attachStepTools(
  env: Omit<BaseEnv, "authorize">,
  materialization: StepToolMaterialization,
): void {
  setStepToolSlot(env, materialization);
}

/** definitions is forwarded verbatim: this wrapper must not rename tools the deploy-time walk enumerated. */
export function rewrapStepToolFactory(
  annotated: AnnotatedToolFactory<BaseEnv>,
  onDispose: (dispose: () => unknown) => void,
  credentials: HostCredentialCapability | undefined,
): AnnotatedToolFactory<BaseEnv> {
  return defineTool({
    id: annotated.id,
    requires: annotated.requires,
    definitions: annotated.definitions,
    factory: (factoryEnv: BaseEnv): ToolBundle => {
      const env =
        credentials === undefined ? factoryEnv : layerCredentialsOntoEnv(factoryEnv, credentials);
      const bundle = annotated(env);
      if (bundle.dispose !== undefined) {
        onDispose(bundle.dispose);
      }
      return bundle;
    },
  });
}

/** Spread preserves every other env surface (including the private tool slot); only capabilities is replaced. */
function layerCredentialsOntoEnv(
  factoryEnv: BaseEnv,
  credentials: HostCredentialCapability,
): BaseEnv {
  const base = requireCapabilitiesBag(factoryEnv);
  const layered = layerRuntimeCapabilities(base, { credentials });
  // Reflect.set, not a literal: BaseEnv doesn't type "capabilities", so a
  // `{ ...factoryEnv, capabilities }` literal trips the excess-property check.
  const layeredEnv: BaseEnv = { ...factoryEnv };
  Reflect.set(layeredEnv, "capabilities", layered);
  return layeredEnv;
}

/** Falls back to createAgent(def, env) unchanged when the env carries no materialized tools (e.g. a bare-factory test). */
export function createToolBearingAgentFactory(): <EnvReq extends BaseEnv>(
  def: AgentDefinition<EnvReq>,
  env: EnvReq,
) => Promise<Agent> {
  return async <EnvReq extends BaseEnv>(
    def: AgentDefinition<EnvReq>,
    env: EnvReq,
  ): Promise<Agent> => {
    const materialization = getStepToolSlot(env);
    if (materialization === undefined) {
      return createAgent(def, env);
    }

    // Fails the launch here, loudly, rather than at the tool's first resolve.
    const credentialWiring = getStepCredentialWiring(env);
    const credentialCapabilities =
      credentialWiring === undefined
        ? new Map<string, HostCredentialCapability>()
        : buildCredentialCapabilities(materialization.factories, credentialWiring);

    // Set, not array: dedupes by closure identity so a bundle whose dispose
    // is the same on every invocation isn't torn down once per push.
    const capturedDisposers = new Set<() => unknown>();
    for (const capability of credentialCapabilities.values()) {
      capturedDisposers.add(() => capability.dispose());
    }
    const factoriesWithCapture = materialization.factories.map((stf) =>
      rewrapStepToolFactory(
        stf.factory,
        (dispose) => {
          capturedDisposers.add(dispose);
        },
        credentialCapabilities.get(stf.packageName),
      ),
    );

    // Shared between success teardown and the construction-failure rollbacks
    // below, since credentials capabilities are built before the plugin
    // chain and must still be released if a later step throws.
    const runCapturedDisposers = async (): Promise<unknown[]> => {
      const failures: unknown[] = [];
      for (const dispose of capturedDisposers) {
        try {
          await dispose();
        } catch (cause) {
          logger.error`step tool bundle dispose failed: ${cause instanceof Error ? cause.message : String(cause)}`;
          failures.push(cause);
        }
      }
      return failures;
    };

    // The serialized def.toolFactories carry only { id, requires } metadata
    // (the workflow projection strips closures on the wire), so the runnable
    // factories come from materialization, not the incoming def.
    const toolDef = defineAgent({
      id: def.id,
      systemPrompt: def.systemPrompt,
      tools: factoriesWithCapture,
      capabilities: [...def.capabilities],
      inference: { sources: [...def.inference.sources] },
      ...(def.description !== undefined ? { description: def.description } : {}),
      ...(def.director !== undefined ? { director: def.director } : {}),
      ...(def.tags !== undefined ? { tags: def.tags } : {}),
    });

    // One at a time so each factory sees prior plugins' instances on
    // env.plugins (posix reads them; LSP populates them). On a midway
    // throw, every constructed instance is released so nothing leaks.
    const pluginInstances: unknown[] = [];
    let chainEnv: BaseEnv = env;
    try {
      for (const factory of materialization.pluginFactories) {
        const instance = factory(chainEnv);
        pluginInstances.push(instance);
        chainEnv = {
          ...env,
          plugins: [...pluginInstances],
        };
      }
    } catch (err) {
      await runCapturedDisposers();
      await disposeAll(pluginInstances, "plugin construction rollback");
      throw err;
    }

    let agent: Agent;
    try {
      agent = await createAgent(toolDef, chainEnv);
    } catch (err) {
      // createAgent disposes its own tool bundles on failure, but the
      // credentials capabilities and plugin instances are this module's to own.
      await runCapturedDisposers();
      await disposeAll(pluginInstances, "agent construction failure");
      throw err;
    }

    return wrapAgentClose(agent, async () => {
      // Disposing the LSP plugin twice is safe (idempotent); running both
      // guarantees teardown even for a plugin no tool bundle consumed.
      const failures = [
        ...(await runCapturedDisposers()),
        ...(await disposeAll(pluginInstances, "step teardown")),
      ];
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `step agent close: ${String(failures.length)} disposer(s) failed during teardown; an LSP subprocess may be leaked`,
        );
      }
    });
  };
}

/** Teardown runs after the agent's own close so the reactor has stopped issuing tool calls first. */
function wrapAgentClose(agent: Agent, teardown: () => Promise<void>): Agent {
  let tornDown = false;
  return {
    ...agent,
    send: (content, opts) => agent.send(content, opts),
    stream: () => agent.stream(),
    deliver: (message) => agent.deliver(message),
    setSource: (source) => agent.setSource(source),
    history: () => agent.history(),
    checkpoints: (limit) => agent.checkpoints(limit),
    readAt: (hash) => agent.readAt(hash),
    blobReader: agent.blobReader,
    async close() {
      await agent.close();
      if (tornDown) return;
      tornDown = true;
      await teardown();
    },
  };
}

async function disposeAll(instances: readonly unknown[], context: string): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const instance of instances) {
    const dispose = pluginDispose(instance);
    if (dispose === undefined) continue;
    try {
      // `await` accepts non-promise values verbatim, so this works
      // whether the disposer is sync or async.
      await dispose();
    } catch (cause) {
      logger.error`step plugin dispose failed during ${context}: ${cause instanceof Error ? cause.message : String(cause)}`;
      failures.push(cause);
    }
  }
  return failures;
}

/** Plugin instance type is unknown (host-defined shapes the runtime doesn't interpret). */
function pluginDispose(value: unknown): (() => unknown) | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (!("dispose" in value)) return undefined;
  const dispose: unknown = value.dispose;
  if (typeof dispose !== "function") return undefined;
  const fn = dispose;
  return () => fn.call(value);
}
