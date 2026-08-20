// Production `WorkflowRuntimeEnv.ActionInvoker` binding.
//
// Resolves an action's `handler` string ref to a host TypeScript function,
// builds a capability- and ledger-checked `EffectContext`, and runs the
// handler. Mirrors runLocal's default action invoker so the production
// host and the in-process test host share one contract.
//
// Fail-closed: an unknown handler ref throws rather than silently returning
// a stub output. A silent stub would let action workflows pass while their
// effects never ran.

import {
  createEffectContext,
  type ActionHandler,
  type ActionInvoker,
  type EffectLedger,
  type LoopFn,
  type LoopFnRegistry,
  type WorkflowAuthorizeFn,
} from "@intx/workflow";

export type { ActionHandler };

export type WorkflowActionInvokerOpts = {
  authorize: WorkflowAuthorizeFn;
  effects: EffectLedger;
  /**
   * Resolve a handler ref to a deterministic effect handler. Production
   * wires a registry of host-owned handlers; tests inject a closed map.
   */
  resolveHandler: (ref: string) => ActionHandler;
};

/**
 * Construct the production action invoker. The returned callable is the
 * runtime-env `invokeAction` surface.
 */
export function createWorkflowActionInvoker(
  opts: WorkflowActionInvokerOpts,
): ActionInvoker {
  return async ({ handler, input, requires, authzContext, signal }) => {
    const fn = opts.resolveHandler(handler);
    const ctx = createEffectContext({
      authorize: opts.authorize,
      effects: opts.effects,
      requires,
      authzContext,
      input,
    });
    const output = await fn(input, ctx, signal);
    return { output };
  };
}

/**
 * Build a fail-closed action-handler registry from a static map.
 * Unknown refs throw with the ref name so a missing registration is
 * obvious in the run failure. Pass `{}` for a default that rejects every ref.
 */
export function createActionHandlerRegistry(
  handlers: Readonly<Record<string, ActionHandler>>,
): (ref: string) => ActionHandler {
  return failClosedRegistry(handlers, "action handler");
}

/**
 * Build a fail-closed loop pure-function registry from a static map.
 * Unknown `while`/`carry` refs throw with the ref name. Pass `{}` for a
 * default that rejects every ref.
 */
export function createLoopFnRegistry(
  fns: Readonly<Record<string, LoopFn>>,
): LoopFnRegistry {
  return failClosedRegistry(fns, "loop fn");
}

function failClosedRegistry<T>(
  items: Readonly<Record<string, T>>,
  label: string,
): (ref: string) => T {
  return (ref) => {
    const item = items[ref];
    if (item === undefined) {
      throw new Error(
        `unknown ${label} ${JSON.stringify(ref)}; register it via the host ${label === "action handler" ? "action-handler" : "loop-fn"} registry`,
      );
    }
    return item;
  };
}
