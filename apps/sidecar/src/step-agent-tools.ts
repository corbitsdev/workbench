// Per-step tool materialization and agent construction for the
// workflow-process child.
//
// The child IS the sidecar binary, so the sidecar's tool runtime
// (`@intx/tool-packaging` loader, posix, the LSP plugin) is present in
// the child's address space. This module is the seam that runs that
// runtime when the real step-invoker builds a step's agent: it reads
// the step's deploy tree off disk, materializes the pinned tool-package
// closure via `materializeToolPackages`, builds the plugin chain,
// attaches the resulting tool factories to the step's
// `AgentDefinition`, and returns an `Agent` whose `close()` tears every
// plugin and tool bundle down.
//
// LSP lifecycle (the riskiest sub-item): the LSP plugin
// factory's `dispose` terminates the LSP subprocess. The
// `createWorkflowStepInvoker` adapter calls `agent.close()` in a
// `finally` on EVERY exit path (clean completion, abort, rejection),
// so wrapping `close()` to also run the plugin + bundle disposers is
// what guarantees the LSP subprocess dies with the step's agent --
// no leak across steps, on abort, or on child recycle/drain (recycle
// kills the child process, which kills the LSP grandchild regardless).
//
// Layering: everything here lives in `apps/sidecar`. The
// portable `@intx/workflow-host` package never gains a dependency on
// the tool runtime; it only sees the `agentFactory` callback this
// module produces.

import path from "node:path";

import {
  createAgent,
  defineAgent,
  defineTool,
  type Agent,
  type AgentDefinition,
  type AnnotatedPluginFactory,
  type BaseEnv,
  type ToolBundle,
} from "@intx/agent";
import { toolConsumer, type GrantRule } from "@intx/authz";
import {
  createCredentialCapability,
  type CredentialProviderRegistry,
  type HostCredentialCapability,
  type ResolvedCredentialBinding,
} from "@intx/harness";
import { readDeployTree, agentDir } from "@intx/hub-agent/paths";
import { getLogger } from "@intx/log";
import type { LoadedToolFactory, RegistryConfig } from "@intx/tool-packaging";
import { resolveStepAddress } from "@intx/workflow-deploy";
import { parseRunAddress } from "@intx/types";
import type { CredentialWiring } from "@intx/workflow-host";

import { materializeToolPackages } from "./tool-materialization";

const logger = getLogger(["sidecar", "workflow-child", "step-tools"]);

/**
 * Cache and registry caps the per-step tool loader needs. Resolved at
 * the sidecar boot edge from the existing `SIDECAR_CACHE_*` /
 * `SIDECAR_REGISTRY_*` config keys and threaded into the child through
 * the substrate config, so the child's per-step materialization is
 * bounded by those boot-edge-resolved caps.
 */
export interface StepToolCacheConfig {
  readonly cacheMaxBytes: number;
  readonly registryMaxTarballBytes: number;
}

/**
 * Materialized tool runtime for one step's agent. Carried from
 * `buildEnv` (which knows the step's identity) to the `agentFactory`
 * (which knows the agent definition + env) via a symbol-keyed slot on
 * the per-step env so the two callbacks of `createWorkflowStepInvoker`
 * can cooperate without widening the portable adapter's surface.
 */
export interface StepToolMaterialization {
  readonly factories: readonly LoadedToolFactory[];
  readonly pluginFactories: readonly AnnotatedPluginFactory[];
}

/**
 * Symbol-keyed slot the `buildEnv` callback sets on the env it returns
 * and the `agentFactory` reads. Object spread (`{ ...envBase,
 * authorize }`) inside the step-invoker adapter copies own enumerable
 * symbol-keyed properties, so the slot survives the spread that
 * produces the env handed to `agentFactory`.
 */
const STEP_TOOLS = Symbol("intx.sidecar.step-tools");

// The per-step env carries one private symbol-keyed slot the
// buildEnv/agentFactory pair cooperate over. The slot is read/written
// through `Reflect.get`/`Reflect.set` so neither site needs a type
// assertion: `BaseEnv` is an interface without a symbol index
// signature, so a structural cast would otherwise be required.
function setStepToolSlot(
  env: object,
  materialization: StepToolMaterialization,
): void {
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

function isStepToolMaterialization(
  value: unknown,
): value is StepToolMaterialization {
  return (
    typeof value === "object" &&
    value !== null &&
    "factories" in value &&
    "pluginFactories" in value &&
    Array.isArray(value.factories) &&
    Array.isArray(value.pluginFactories)
  );
}

/**
 * The per-step credential inputs `buildEnv` carries to the tool-bearing
 * `agentFactory` via a second symbol-keyed slot, mirroring `STEP_TOOLS`:
 * the live `CredentialWiring` the child's runtime built (materialRef +
 * grant resolver) plus this invocation's `stepId`, which
 * `resolveStepGrants` is keyed on. `attachStepCredentials` is called from
 * `createSidecarStepBuildEnv` for a tool-bearing step; a toolless step
 * (an onTrigger body) never calls it, so the slot is absent there and no
 * tool ever asks for a credential.
 */
export interface StepCredentialContext {
  readonly wiring: CredentialWiring;
  readonly stepId: string;
}

const STEP_CREDENTIALS = Symbol("intx.sidecar.step-credentials");

function isStepCredentialContext(
  value: unknown,
): value is StepCredentialContext {
  return (
    typeof value === "object" &&
    value !== null &&
    "wiring" in value &&
    "stepId" in value
  );
}

/**
 * Attach this step's credential wiring to the per-step env so the
 * tool-bearing `agentFactory` can shape a consumer-scoped `credentials`
 * capability for each tool package that declares one. Called by
 * `buildEnv` once the `CredentialWiring` the child's runtime carries is
 * known.
 */
export function attachStepCredentials(
  env: object,
  context: StepCredentialContext,
): void {
  Reflect.set(env, STEP_CREDENTIALS, context);
}

/**
 * Read back the credential context `attachStepCredentials` set on the
 * per-step env.
 */
export function getStepCredentialContext(
  env: object,
): StepCredentialContext | undefined {
  const value: unknown = Reflect.get(env, STEP_CREDENTIALS);
  if (value === undefined) return undefined;
  if (!isStepCredentialContext(value)) {
    throw new Error(
      "sidecar workflow-child step tools: the per-step env's credentials slot is not a StepCredentialContext; the slot is private to this module and must only be set by attachStepCredentials",
    );
  }
  return value;
}

/**
 * The package portion of a package-namespaced tool id
 * (`@vendor/pkg/name` or `pkg/name`), i.e. the id with its trailing
 * `/name` segment removed. This is the same string a tool package's
 * `package.json` `name` field carries, which is what launch-time
 * credential binding (`toolConsumer`, `vendor/intx/db/src/
 * credential-resolution.ts`) keys the consumer identity on -- so a tool
 * factory's `id` and its declared credential handles resolve to the
 * same consumer here without a second source of truth.
 *
 * Trust boundary: this derives the consumer identity from the tool
 * bundle's OWN self-declared `id` string (`defineTool({ id, ... })`,
 * `@intx/agent/src/tool.ts`) -- nothing in the loader checks that a
 * factory whose `id` claims package X actually shipped inside package
 * X's tarball. A factory could declare `id: "@corbits/granola-tools/
 * granola"` from inside a different package's code and this function
 * would hand it that package's `credentials` capability, resolving
 * whatever the launch bound to the real `@corbits/granola-tools`
 * consumer. This is acceptable ONLY because tool packages are
 * operator-installed, root-bucket-trusted code (AGENTS.md: "Root-bucket
 * modules are operator-installed... sandboxed installables use
 * Interchange's native contracts and never get root-bucket powers") --
 * the same trust level a root-bucket module already holds to declare
 * routes, migrations, and grants. It is NOT a boundary that holds against
 * a hostile or sandboxed tool package, which this substrate never loads.
 * Binding the loader's package-provenance to a factory's declared `id` is
 * a real gap for a future untrusted-tool-package story; it is filed and
 * tracked separately from this wiring, not solved here.
 */
export function packageFromToolId(id: string): string {
  const lastSlash = id.lastIndexOf("/");
  if (lastSlash <= 0) {
    throw new Error(
      `sidecar workflow-child step tools: tool id ${JSON.stringify(id)} is not package-namespaced`,
    );
  }
  return id.slice(0, lastSlash);
}

/**
 * Resolve the on-disk directory holding a step's deploy tree.
 *
 * The deploy tree (`deploy/prompt.md`, `deploy/tool-packages-manifest.json`,
 * `deploy/asset-mounts.json`) is shipped to the sidecar per step by the
 * hub's `launchSession` deploy-pack push, which lands it in the LEGACY
 * per-agent directory keyed by the step's sanitized mail address (see
 * `@intx/hub-agent` `agentDir`). It is NOT in the
 * substrate's `agent-state/<id>` layout -- the multi-step deploy path
 * never pushes step `agent-state` packs to the child's substrate.
 *
 * The step's mail address is `resolveStepAddress(...)`, the single owner
 * of the head/step collapse: for a single-step deployment the lone step
 * IS the head (the deployment mailbox itself), so the tree is read at the
 * head; for multi-step it is the derived `<runId>-<stepId>@<domain>` step
 * address. The anchor `runId`/`domain` are recovered from the deployment
 * mailbox address the supervisor threaded into the child as
 * `MAILBOX_ADDRESS` (`<runId>@<domain>`). `stepCount` is sourced from
 * the host (via `substrateEnv`) so producer and consumer never derive
 * divergent addresses.
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
  const stepAddress = resolveStepAddress({
    runId: parsed.runId,
    stepId: args.stepId,
    domain: parsed.domain,
    stepCount: args.stepCount,
  });
  return agentDir(args.dataDir, stepAddress);
}

/**
 * Read a step's deploy tree and materialize its pinned tool-package
 * closure. The tarball cache and the tool instance dir are rooted under
 * the supplied per-step `storeDir` (the per-step state root) so
 * concurrent steps/agents in one child never collide on cache or
 * apply-state paths.
 *
 * A deploy with no tool-package manifest yields empty factories -- the
 * legitimate `rawManifestBytes === undefined` case. A manifest that is
 * present but fails to load surfaces loudly through
 * `materializeToolPackages` (the throw path), never a silent
 * empty-tools fallback that would mask a broken deploy.
 */
export async function materializeStepTools(args: {
  dataDir: string;
  mailboxAddress: string;
  stepId: string;
  stepCount: number;
  /** Per-step state root; cache + instance dir + workspace live under it. */
  storeDir: string;
  cache: StepToolCacheConfig;
  /**
   * Tool-package registries the loader resolves against, parsed from
   * the boot-edge-threaded `SIDECAR_TOOL_REGISTRIES` substrate-config
   * entry so a child materializes against the registries the operator
   * pinned, never a default of its own.
   */
  registries: ReadonlyMap<string, RegistryConfig>;
}): Promise<StepToolMaterialization> {
  const deployTreeDir = stepDeployTreeDir({
    dataDir: args.dataDir,
    mailboxAddress: args.mailboxAddress,
    stepId: args.stepId,
    stepCount: args.stepCount,
  });
  const deployTree = await readDeployTree(deployTreeDir);

  // Root the tarball cache per step so concurrent steps in one child
  // do not race on the content-addressable cache root. The cache is
  // content-addressed and therefore safe to share globally, but the
  // design calls for a per-step cacheRoot so a wedged
  // or partially-written apply in one step cannot corrupt another's
  // view.
  const cacheRoot = path.join(args.storeDir, "tarball-cache");

  // Asset-mounted tool tarballs are staged by the hub's asset-pack push
  // into the step's LEGACY agent dir workspace (the same dir the deploy
  // tree lives in), not under the per-step store dir. Point the loader's
  // asset resolution there while keeping the apply-state + cache rooted
  // per step under `storeDir`.
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
    registries: args.registries,
  });
  return {
    factories: materialized.factories,
    pluginFactories: materialized.pluginFactories,
  };
}

/**
 * Attach a step's materialized tool runtime to the per-step env so the
 * tool-bearing `agentFactory` can consume it. Called by `buildEnv`
 * after `materializeStepTools` resolves.
 *
 * The parameter is `Omit<BaseEnv, "authorize">` because `buildEnv`
 * yields exactly that shape (the step-invoker adapter adds `authorize`
 * before the env reaches `agentFactory`); the symbol slot survives the
 * adapter's `{ ...envBase, authorize }` spread.
 */
export function attachStepTools(
  env: Omit<BaseEnv, "authorize">,
  materialization: StepToolMaterialization,
): void {
  setStepToolSlot(env, materialization);
}

/**
 * Build the `agentFactory` the workflow step-invoker uses. The returned
 * factory reads the materialized tool runtime off the env (set by
 * `buildEnv` via `attachStepTools`), augments the step's
 * `AgentDefinition` with the loaded tool factories (wrapped to capture
 * each bundle's disposer), constructs the plugin chain on `env.plugins`,
 * builds the agent, and wraps
 * `agent.close()` so every plugin instance and tool bundle is disposed
 * when the step's agent closes.
 *
 * When the env carries no materialized tools (the `buildEnv` did not
 * run materialization, e.g. a unit test using the bare factory), the
 * factory falls back to `createAgent(def, env)` unchanged.
 *
 * `deps.providers` is the fixed `CredentialProviderRegistry` the child
 * builds once at boot (`builtinCredentialProviders()`, composed via
 * `@intx/harness`'s `createCredentialProviderRegistry`). It is the only
 * credential dependency that is NOT per-step: the wiring (materials +
 * grants) varies per step and rides the env's credential slot instead
 * (see `attachStepCredentials`).
 */
export function createToolBearingAgentFactory(deps: {
  providers: CredentialProviderRegistry;
}): <EnvReq extends BaseEnv>(
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

    // Consumer-scoped `credentials` capabilities for this step's tool
    // packages, built lazily (only for a tool factory that actually
    // declares `requires: ["credentials"]`) and memoized by consumer so
    // two bundles from the same package share one capability -- and one
    // `dispose()` -- rather than shaping the same handle twice.
    //
    // Always returns a capability, never `undefined`: `requires:
    // ["credentials"]` makes the runtime's presence-only `validateEnv`
    // demand a non-nullish `env.credentials` at agent construction, so
    // the "not connected" signal has to live in `resolve()` throwing,
    // not in the field's presence. A step with no credential wiring at
    // all (`getStepCredentialContext` returns `undefined` -- a toolless
    // body step never calls `attachStepCredentials`) or a consumer with
    // no bound handle both yield a capability with an empty binding map,
    // so every `resolve(handle)` call throws "no credential is bound"
    // and the tool reports the same honest not-connected result either
    // way.
    const credentialContext = getStepCredentialContext(env);
    const credentialCapabilities = new Map<string, HostCredentialCapability>();
    function credentialCapabilityFor(
      consumer: string,
    ): HostCredentialCapability {
      const existing = credentialCapabilities.get(consumer);
      if (existing !== undefined) return existing;
      const bindings = consumerBindings(credentialContext, consumer);
      const capability = createCredentialCapability({
        consumer,
        bindings,
        providers: deps.providers,
        grants:
          bindings.size === 0 || credentialContext === undefined
            ? []
            : [
                ...(credentialContext.wiring.resolveStepGrants(
                  credentialContext.stepId,
                ) as readonly GrantRule[]),
              ],
      });
      credentialCapabilities.set(consumer, capability);
      return capability;
    }

    // Wrap each loaded tool factory so its bundle's `dispose` (when
    // present) is captured. Dedupe by closure identity: a factory whose
    // bundle returns the same `dispose` on every invocation must not be
    // torn down once per
    // push. `defineTool` re-annotates the wrapper with the loader's
    // `id`/`requires` so the resulting factory is a real
    // `AnnotatedToolFactory<BaseEnv>`, not a hand-shaped lookalike.
    const capturedDisposers = new Set<() => unknown>();
    const factoriesWithCapture = materialization.factories.map((annotated) => {
      const consumer = toolConsumer(packageFromToolId(annotated.id));
      return defineTool({
        id: annotated.id,
        requires: annotated.requires,
        definitions: annotated.definitions,
        factory: (factoryEnv: BaseEnv): ToolBundle => {
          const credentials = annotated.requires.includes("credentials")
            ? credentialCapabilityFor(consumer)
            : undefined;
          const scopedEnv: BaseEnv & {
            credentials?: HostCredentialCapability;
          } =
            credentials !== undefined
              ? { ...factoryEnv, credentials }
              : factoryEnv;
          const bundle = annotated(scopedEnv);
          if (bundle.dispose !== undefined) {
            capturedDisposers.add(bundle.dispose);
          }
          return bundle;
        },
      });
    });

    // Rebuild the def with the materialized tool factories. The
    // serialized `def.toolFactories` carry only `{ id, requires }`
    // metadata (the workflow projection strips closures on the wire),
    // so the runnable factories come from materialization, not the
    // incoming def. `defineAgent` owns the contravariance escape for
    // the `BaseEnv`-typed loader factories (see its `EnvRequiredByAll`
    // machinery).
    const toolDefBaseConfig = {
      id: def.id,
      systemPrompt: def.systemPrompt,
      tools: factoriesWithCapture,
      capabilities: [...def.capabilities],
      inference: { sources: [...def.inference.sources] },
    };
    const toolDefConfigWithDescription =
      def.description !== undefined
        ? { ...toolDefBaseConfig, description: def.description }
        : toolDefBaseConfig;
    const toolDefConfigWithDirector =
      def.director !== undefined
        ? { ...toolDefConfigWithDescription, director: def.director }
        : toolDefConfigWithDescription;
    const toolDefConfig =
      def.tags !== undefined
        ? { ...toolDefConfigWithDirector, tags: def.tags }
        : toolDefConfigWithDirector;
    const toolDef = defineAgent(toolDefConfig);

    // Instantiate plugin factories one at a time so each successive
    // factory sees the prior plugins' instances on `env.plugins`:
    // posix's bundle reads `env.plugins` and threads ToolPlugin-shaped
    // values into `createPosixTools`; the LSP plugin factory is what
    // populates them.
    //
    // On a midway factory throw, every plugin instance already
    // constructed releases what it acquired (the LSP plugin starts a
    // subprocess) before the construction error propagates, so a
    // partial-success chain never leaks an LSP subprocess.
    const pluginInstances: unknown[] = [];
    let chainEnv: BaseEnv & { credentials?: HostCredentialCapability } = env;
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
      await disposeAll(pluginInstances, "plugin construction rollback");
      await disposeCredentialCapabilities(credentialCapabilities);
      throw err;
    }

    // `createAgent`'s presence-only `validateEnv` checks every tool
    // contributor's declared `requires` keys against THIS shared
    // `chainEnv`, not against the per-tool `scopedEnv` each wrapped
    // factory above builds for itself when it actually runs -- so a
    // `requires: ["credentials"]` tool (e.g. `@corbits/mcp-tools`)
    // needs `chainEnv.credentials` to already be non-nullish here, even
    // though every such factory's own wrapper unconditionally replaces
    // the value with its consumer-scoped capability before building its
    // bundle. Without this, `validateEnv` throws `AgentEnvError` before
    // any factory ever runs. Which consumer's capability lands on the
    // shared env does not matter for correctness -- it is never read
    // directly, only overridden -- so the first credential-requiring
    // factory's capability satisfies the presence check for all of
    // them.
    const credentialRequiringFactory = materialization.factories.find(
      (factory) => factory.requires.includes("credentials"),
    );
    if (credentialRequiringFactory !== undefined) {
      chainEnv = {
        ...chainEnv,
        credentials: credentialCapabilityFor(
          toolConsumer(packageFromToolId(credentialRequiringFactory.id)),
        ),
      };
    }

    let agent: Agent;
    try {
      agent = await createAgent(toolDef, chainEnv);
    } catch (err) {
      // `createAgent` disposes the tool bundles it constructed on its
      // own failure path, but the plugin instances and credential
      // capabilities are this module's to own -- tear them down so a
      // failed agent build does not leak the LSP subprocess or a
      // shaped credential handle.
      await disposeAll(pluginInstances, "agent construction failure");
      await disposeCredentialCapabilities(credentialCapabilities);
      throw err;
    }

    return wrapAgentClose(agent, async () => {
      // Tool bundle disposers first (posix's bundle dispose chains
      // through to the LSP plugin's `dispose`), then the plugin
      // instances directly. Disposing the LSP plugin twice is safe:
      // `lsp.dispose()` clears its client set and the posix bundle's
      // dispose is idempotent. Running both guarantees the LSP
      // subprocess is torn down even for a plugin no tool bundle
      // consumed.
      // Every disposer runs and failures are collected rather than thrown
      // mid-loop, so one failing disposer never strands the rest. A leaked
      // or failing LSP subprocess must surface, not be swallowed: any
      // collected failure fails the close, so the caller sees it.
      const failures: unknown[] = [];
      for (const dispose of capturedDisposers) {
        try {
          await dispose();
        } catch (cause) {
          logger.error`step tool bundle dispose failed: ${cause instanceof Error ? cause.message : String(cause)}`;
          failures.push(cause);
        }
      }
      failures.push(...(await disposeAll(pluginInstances, "step teardown")));
      await disposeCredentialCapabilities(credentialCapabilities);
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `step agent close: ${String(failures.length)} disposer(s) failed during teardown; an LSP subprocess may be leaked`,
        );
      }
    });
  };
}

/**
 * Release every consumer-scoped credential capability this step shaped.
 * Mirrors `disposeAll`'s best-effort policy: one capability's disposal
 * failure is logged and swallowed rather than blocking the others or the
 * step's own teardown.
 */
async function disposeCredentialCapabilities(
  capabilities: ReadonlyMap<string, HostCredentialCapability>,
): Promise<void> {
  for (const capability of capabilities.values()) {
    try {
      await capability.dispose();
    } catch (cause) {
      logger.warn`step credential capability dispose failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
}

/**
 * Resolve one consumer's bound credential handles from the step's live
 * `CredentialDelivery` snapshot. Reads `materialRef.current` fresh (not
 * captured at closure-build time) so a `credentials-updated` control
 * frame that lands before this step's tools resolve their first handle
 * is reflected. `readCurrentMaterial` on each binding likewise re-reads
 * the ref per call -- the rotation indirection `createCredentialCapability`
 * documents.
 *
 * A binding whose `credentialId` has no matching `materials` entry is a
 * delivery-payload integrity fault (`buildCredentialDelivery` always
 * pairs a binding with its material) and throws rather than silently
 * dropping the handle.
 */
export function consumerBindings(
  context: StepCredentialContext | undefined,
  consumer: string,
): ReadonlyMap<string, ResolvedCredentialBinding> {
  const bindings = new Map<string, ResolvedCredentialBinding>();
  if (context === undefined) return bindings;
  const delivery = context.wiring.materialRef.current;
  if (delivery === null) return bindings;
  for (const binding of delivery.bindings) {
    if (binding.consumer !== consumer) continue;
    const material = delivery.materials.find(
      (entry) => entry.credentialId === binding.credentialId,
    );
    if (material === undefined) {
      throw new Error(
        `sidecar workflow-child step tools: credential delivery binds handle ${JSON.stringify(binding.handle)} to credential ${binding.credentialId} with no matching material entry`,
      );
    }
    bindings.set(binding.handle, {
      credentialId: binding.credentialId,
      providerKey: material.providerKey,
      origin: material.origin,
      readCurrentMaterial: () => {
        const current = context.wiring.materialRef.current;
        const currentMaterial = current?.materials.find(
          (entry) => entry.credentialId === binding.credentialId,
        );
        if (currentMaterial === undefined) {
          throw new Error(
            `sidecar workflow-child step tools: credential ${binding.credentialId} material is no longer available (rotated or revoked mid-step)`,
          );
        }
        return { secret: currentMaterial.secret };
      },
    });
  }
  return bindings;
}

/**
 * Return an `Agent` whose `close()` runs the original close and then
 * the supplied teardown. The teardown runs AFTER the agent's own close
 * so the reactor has stopped issuing tool calls before the tool/plugin
 * resources are released. `close()` is idempotent at the agent layer;
 * this wrapper guards its own teardown so a double `close()` does not
 * double-dispose.
 */
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

async function disposeAll(
  instances: readonly unknown[],
  context: string,
): Promise<unknown[]> {
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

/**
 * Extract a callable `dispose` from a plugin instance whose static type
 * is `unknown` (plugin factories return host-defined shapes the agent
 * runtime does not interpret). Returns a bound disposer or `undefined`
 * when the instance carries no `dispose` function.
 */
function pluginDispose(value: unknown): (() => unknown) | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (!("dispose" in value)) return undefined;
  const dispose: unknown = value.dispose;
  if (typeof dispose !== "function") return undefined;
  const fn = dispose;
  return () => fn.call(value);
}
