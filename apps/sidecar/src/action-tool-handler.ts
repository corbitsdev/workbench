// Host-side action-handler registry for the native `action` primitive
// (WORKBENCH-OWNED, no upstream counterpart -- the sidecar-local pairing
// to `@intx/workflow-host`'s fail-closed `createActionHandlerRegistry`,
// ported from gtm-workbench's `apps/sidecar/src/action-tool-handler.ts`;
// see docs/revendor-inventory.md for what carried over unchanged and
// what is new).
//
// An `action` step carries no `AgentDefinition` -- only a `handler`
// string ref, an optional `input` selector, and `effect.requires`
// capability names. The workflow runtime never resolves `handler`
// itself (mirroring how it never reads `agent.toolFactories`);
// resolving it to a concrete TypeScript function is entirely the
// host's job.
//
// `handler` is FLAT: it is a materialized tool's canonical dispatch
// name (`ToolDefinition.name`, the same string `bundle.run({name, ...})`
// dispatches on and the same vocabulary `effect.requires` uses), nothing
// more.
//
// Departure from gtm's port: gtm's registry enumerates action steps by
// re-reading the deployed `workflow.json` off disk
// (`loadActionHandlerStepIds`), duplicating the read `packages/
// workflow-host`'s `run-child.ts` does moments later. Workbench retired
// `workflow.json` as a host-read format in favor of the resolved
// in-memory `WorkflowDefinition` the closure loader already hands the
// sidecar (`loadVerifiedWorkflowDefinition` /
// `loadWorkflowDefinitionFromClosure`, `@intx/workflow-host`) -- so this
// registry takes that resolved `WorkflowDefinition` object directly as
// an argument instead of re-parsing anything off disk.
//
// Second departure: gtm's registry resolves each ref's `StepToolContext`
// through `step-tool-harness.ts` (`resolveStepToolContext` /
// `runDeterministicToolStep` / `assertStepToolResolvable`), a
// deterministic-tool-dispatch harness workbench has no analog of.
// Workbench dispatches tools only inside an agent reactor
// (`createToolBearingAgentFactory`, `step-agent-tools.ts`). This module
// instead materializes a step's tool-package closure directly via
// `materializeStepTools`, shapes the same consumer-scoped `credentials`
// capability `createToolBearingAgentFactory` shapes for a deterministic
// step (reusing its exported `getStepCredentialContext` /
// `packageFromToolId` / `consumerBindings` helpers), and dispatches the
// named tool through the materialized `ToolBundle.run` directly -- no
// agent, no reactor, no LSP/plugin chain (an action step has no
// `AgentDefinition`, so none of that machinery applies).
//
// Eager beats lazy here on purpose, same as gtm: every action step's
// tool closure is resolved once, when this registry is constructed, so
// a missing tool package or an unresolvable credential fails the moment
// the deployment is established rather than mid-run.

import crypto from "node:crypto";

import { type } from "arktype";
import type { ActionHandler } from "@corbits/workflow-host-actions";
import type { WorkflowDefinition } from "@intx/workflow/definition";
import type { AnnotatedToolFactory, BaseEnv, ToolBundle } from "@intx/agent";
import { toolConsumer, type GrantRule } from "@intx/authz";
import {
  createCredentialCapability,
  type CredentialProviderRegistry,
  type HostCredentialCapability,
} from "@intx/harness";
import type { LoadedToolFactory, RegistryConfig } from "@intx/tool-packaging";

import {
  attachStepCredentials,
  consumerBindings,
  getStepCredentialContext,
  materializeStepTools,
  packageFromToolId,
  type StepCredentialContext,
  type StepToolCacheConfig,
  type StepToolMaterialization,
} from "./step-agent-tools";

/** Injectable seam over `materializeStepTools` so a unit test can supply a
 * fake tool-package closure instead of reading a real deploy tree off
 * disk. Production callers omit it and get the real materializer. */
export type MaterializeStepTools = (
  args: ActionStepMaterializationArgs,
) => Promise<StepToolMaterialization>;

/** Boundary validator for an action-step's input before it reaches a tool's
 * `arguments` map -- a tool call's `arguments` is a flat record, never an
 * arbitrary JSON value, so a non-record `input` selector result fails
 * closed here instead of surfacing as a confusing tool-runner error. */
const ToolCallArguments = type("Record<string, unknown>");

/**
 * Everything one `kind: "action"` step needs materialized before its
 * `handler` ref(s) can dispatch: the resolved tool-package closure plus
 * (optionally) the credential wiring `getStepCredentialContext` reads
 * back. Mirrors the inputs `materializeStepTools` +
 * `attachStepCredentials` already take for a deterministic/inference
 * step -- this module is the action-primitive analog of that same seam.
 */
export interface ActionStepMaterializationArgs {
  readonly dataDir: string;
  readonly mailboxAddress: string;
  readonly stepId: string;
  readonly stepCount: number;
  readonly storeDir: string;
  readonly cache: StepToolCacheConfig;
  readonly registries: ReadonlyMap<string, RegistryConfig>;
  readonly credentials?: Omit<StepCredentialContext, "stepId">;
}

export interface CreateActionToolHandlerRegistryArgs {
  /** The resolved, in-memory workflow definition -- read at the seam the
   * sidecar already holds it (the closure loader's output), never
   * re-parsed off a `workflow.json` on disk. */
  definition: WorkflowDefinition;
  /** Per-action-step materialization inputs, keyed by stepId. A `kind:
   * "action"` step present in `definition.steps` with no entry here
   * throws at registry construction -- fail-closed at establish, not
   * mid-run. */
  materializationByStepId: ReadonlyMap<string, ActionStepMaterializationArgs>;
  providers: CredentialProviderRegistry;
  /** Test seam; production callers omit this and get `materializeStepTools`. */
  materialize?: MaterializeStepTools;
}

/**
 * Every `handler` ref an action step in `definition.steps` declares,
 * paired with the FIRST stepId that declares it. Two action steps
 * sharing one handler ref resolve identically -- the deployment pins one
 * uniform tool-package set per step.
 */
function actionHandlerRefs(
  definition: WorkflowDefinition,
): Map<string, string> {
  const refs = new Map<string, string>();
  for (const [stepId, primitive] of Object.entries(definition.steps)) {
    if (primitive.kind !== "action") continue;
    if (!refs.has(primitive.handler)) {
      refs.set(primitive.handler, stepId);
    }
  }
  return refs;
}

/**
 * Shape the consumer-scoped `credentials` capability for one materialized
 * tool factory, mirroring `createToolBearingAgentFactory`'s
 * `credentialCapabilityFor` -- duplicated rather than shared because that
 * function lives inside the agent-factory closure and this dispatch path
 * has no agent to attach it to.
 */
function credentialCapabilityForFactory(args: {
  factory: LoadedToolFactory;
  credentialContext: StepCredentialContext | undefined;
  providers: CredentialProviderRegistry;
}): HostCredentialCapability | undefined {
  if (!args.factory.requires.includes("credentials")) return undefined;
  const consumer = toolConsumer(packageFromToolId(args.factory.id));
  const bindings = consumerBindings(args.credentialContext, consumer);
  return createCredentialCapability({
    consumer,
    bindings,
    providers: args.providers,
    grants:
      bindings.size === 0 || args.credentialContext === undefined
        ? []
        : [
            ...(args.credentialContext.wiring.resolveStepGrants(
              args.credentialContext.stepId,
            ) as readonly GrantRule[]),
          ],
  });
}

/**
 * Build the scoped `ToolBundle` for one materialized tool factory,
 * injecting a `credentials` capability only when the factory declares it
 * needs one -- same gate `createToolBearingAgentFactory` applies.
 */
function buildScopedBundle(args: {
  factory: LoadedToolFactory;
  env: Omit<BaseEnv, "authorize">;
  credentialContext: StepCredentialContext | undefined;
  providers: CredentialProviderRegistry;
}): ToolBundle {
  const credentials = credentialCapabilityForFactory({
    factory: args.factory,
    credentialContext: args.credentialContext,
    providers: args.providers,
  });
  const scopedEnv: BaseEnv = (
    credentials !== undefined ? { ...args.env, credentials } : args.env
  ) as BaseEnv;
  return (args.factory as unknown as AnnotatedToolFactory)(scopedEnv);
}

/**
 * Bind one `handler` ref to its already-resolved tool closure. Eagerly
 * locates the owning factory (fail-closed at establish if no
 * materialized factory declares a tool by this name), then returns the
 * pure `ActionHandler`: dispatch the tool through the action's
 * capability- and ledger-checked `EffectContext`, return its content.
 */
async function bindActionHandler(args: {
  toolName: string;
  materialization: ActionStepMaterializationArgs;
  providers: CredentialProviderRegistry;
  materialize: MaterializeStepTools;
}): Promise<ActionHandler> {
  const { factories } = await args.materialize(args.materialization);
  const factory = factories.find((f) =>
    f.definitions.some((d) => d.name === args.toolName),
  );
  if (factory === undefined) {
    throw new Error(
      `action-tool-handler: no materialized tool package for step ${JSON.stringify(args.materialization.stepId)} declares a tool named ${JSON.stringify(args.toolName)}`,
    );
  }

  // Placeholder `BaseEnv` slots a tool bundle's `factory(env)` structurally
  // requires but never reads for an action dispatch (no reactor, no
  // `createAgent`) -- mirrors gtm's `buildScratchEnv`. `workdir` is real:
  // tools that touch disk need it.
  const env = {
    sources: [],
    defaultSource: "",
    storage: undefined,
    audit: undefined,
    directors: {},
    workdir: args.materialization.storeDir,
  } as unknown as Omit<BaseEnv, "authorize">;
  if (args.materialization.credentials !== undefined) {
    attachStepCredentials(env, {
      ...args.materialization.credentials,
      stepId: args.materialization.stepId,
    });
  }
  const credentialContext = getStepCredentialContext(env);

  return async (input, ctx, signal): Promise<unknown> => {
    const parsedArgs = ToolCallArguments(input);
    if (parsedArgs instanceof type.errors) {
      throw new Error(
        `action-tool-handler: input for handler ${JSON.stringify(args.toolName)} is not a tool-arguments record: ${parsedArgs.summary}`,
      );
    }
    return ctx.perform({
      effectId: "tool-call",
      capability: args.toolName,
      run: async () => {
        const bundle = buildScopedBundle({
          factory,
          env,
          credentialContext,
          providers: args.providers,
        });
        try {
          const result = await bundle.run(
            {
              id: crypto.randomUUID(),
              name: args.toolName,
              arguments: parsedArgs,
            },
            signal,
          );
          if (result.isError === true) {
            throw new Error(
              `action-tool-handler: tool ${JSON.stringify(args.toolName)} returned an error result: ${typeof result.content === "string" ? result.content : JSON.stringify(result.content)}`,
            );
          }
          return result.content;
        } finally {
          await bundle.dispose?.();
        }
      },
    });
  };
}

/**
 * Build the `(ref) => ActionHandler` registry the sidecar threads into
 * the run-child bindings' `resolveActionHandler` field. Every action
 * step's tool closure is resolved EAGERLY, before this function returns.
 */
export async function createActionToolHandlerRegistry(
  args: CreateActionToolHandlerRegistryArgs,
): Promise<(ref: string) => ActionHandler> {
  const refs = actionHandlerRefs(args.definition);
  const materialize = args.materialize ?? materializeStepTools;

  const handlers = new Map<string, ActionHandler>();
  for (const [toolName, stepId] of refs) {
    const materialization = args.materializationByStepId.get(stepId);
    if (materialization === undefined) {
      throw new Error(
        `action-tool-handler: step ${JSON.stringify(stepId)} declares handler ${JSON.stringify(toolName)} but no materialization args were supplied for it`,
      );
    }
    handlers.set(
      toolName,
      await bindActionHandler({
        toolName,
        materialization,
        providers: args.providers,
        materialize,
      }),
    );
  }

  return (ref: string): ActionHandler => {
    const handler = handlers.get(ref);
    if (handler === undefined) {
      throw new Error(
        `action handler for ${JSON.stringify(ref)}: no action step in the workflow definition declares this handler ref`,
      );
    }
    return handler;
  };
}
