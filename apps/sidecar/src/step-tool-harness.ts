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
import { getLogger } from "@intx/log";
import { createBlobReader } from "@intx/types/runtime";
import type { ContextStore } from "@intx/types/runtime";
import { createPosixTools } from "@intx/tools-posix";
import {
  HUB_RPC_ENV_KEY,
  ToolManifestResponse,
  providerFromEnvKey,
} from "@workbench/tool-credentials";
import { ArgMap } from "@workbench/agents";
import {
  fetchToolCredentials,
  loadToolPackages,
  mergeToolRunners,
  type DefinedRunner,
} from "./agent-tools";

const logger = getLogger(["sidecar", "step-tool-harness"]);

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
  disposers: (() => Promise<void>)[];
}> {
  const { ctx } = args;
  const storeDir = path.dirname(args.workdir);

  const { rawManifestBytes, assetMounts } = await fetchStepToolManifest({
    ctx,
    storeDir,
  });

  const loadedPackages = await loadToolPackages({
    rawManifestBytes,
    assetMounts,
    storeDir,
    agentAddress: ctx.stepAddress,
    cacheRoot: ctx.cacheRoot,
    cacheMaxBytes: ctx.cacheMaxBytes,
    registryMaxTarballBytes: ctx.registryMaxTarballBytes,
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
    hubHttpUrl: ctx.hubHttpUrl,
    sidecarToken: ctx.sidecarToken,
    tenantId: ctx.tenantId,
    agentId: ctx.stepAgentId,
    providerNames: [...requiredProviders],
    agentAddress: ctx.stepAddress,
  });

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
  for (const pkg of loadedPackages) {
    for (const factory of pkg.factories) {
      let bundle: ReturnType<typeof factory>;
      try {
        bundle = factory(factoryEnv);
      } catch (err) {
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
      for (const def of bundle.definitions) loadedToolNames.add(def.name);
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

  // Steps expose every materialized native tool plus local posix tools; the
  // grants-backed `authorize` the factory installs is the real per-call gate,
  // and the hub gates which packages were resolvable at all via the step's
  // pins. No name-filter is applied here — it would be a no-op (every loaded
  // tool name is already in the merged set).
  const merged = mergeToolRunners([
    posixTools,
    ...loadedRunners,
  ]) as DefinedRunner;
  return {
    runner: merged,
    loadedToolNames,
    disposers,
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
 * Reshape the evaluated step input into tool arguments per the step's
 * `argMap`. The argMap JSON is parsed + validated through arktype at this
 * trust boundary. For each `[argName, spec]`: `{ from }` pulls a top-level
 * field off the evaluated input (a missing field fails loud, naming it);
 * `{ literal }` supplies the constant.
 */
function reshapeWithArgMap(
  toolName: string,
  input: unknown,
  argMapJson: string,
): Record<string, unknown> {
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
    if (inputRecord === undefined || !(spec.from in inputRecord)) {
      throw new Error(
        `step-tool-harness: deterministic step "${toolName}" argMap maps tool arg "${argName}" from input field "${spec.from}", but that field is absent on the evaluated step input`,
      );
    }
    toolArguments[argName] = inputRecord[spec.from];
  }
  return toolArguments;
}

export async function runDeterministicToolStep(args: {
  env: Omit<BaseEnv, "authorize">;
  toolName: string;
  input: unknown;
  /** Raw JSON of the step's `workbench.argMap` tag, if present. */
  argMapJson?: string;
  /**
   * When true (the step's `workbench.nonFatal` tag is set), a thrown tool error
   * is logged and degraded to a completed `isError` envelope instead of
   * propagating — so one best-effort source cannot fail the whole run.
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
    if (!available.has(args.toolName)) {
      throw new Error(
        `step-tool-harness: deterministic step declared tool "${args.toolName}" but it is not in the step's loaded runner; the workflow declared a tool that is not pinned (loaded: ${[...available].join(", ") || "none"})`,
      );
    }
    const toolArguments =
      args.argMapJson !== undefined
        ? reshapeWithArgMap(args.toolName, args.input, args.argMapJson)
        : verbatimToolArguments(args.toolName, args.input);
    const result = await runner.run(
      {
        id: `det-${ctx.stepAgentId}`,
        name: args.toolName,
        arguments: toolArguments,
      },
      args.signal,
    );
    return { output: result };
  } catch (cause) {
    // A degrade must never mask cancellation: if the step's signal aborted (run
    // cancel/timeout), the throw is the cancellation, not a source failure —
    // rethrow it so the runtime propagates the cancel instead of letting the
    // run march on into brief/write/persist.
    if (args.nonFatal !== true || args.signal.aborted) {
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

    const { runner, disposers } = await buildStepTools({
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

    const toolsFactory = defineTool({
      id: "@workbench/sidecar/step-tools",
      factory: () => ({
        definitions: runner.definitions,
        run: runner.run.bind(runner),
      }),
    });

    const stepDef = {
      id: def.id,
      systemPrompt: def.systemPrompt,
      toolFactories: [toolsFactory] as const,
      capabilities: [],
      inference: { sources: [] as const },
    };

    const agentEnv = { ...env, authorize };
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
