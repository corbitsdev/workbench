// CL-7201: the live abort seam a running turn is reachable through while
// it is still on our own call stack — the `waitUntilFree` wait, the
// `dispatchTurn` call around `sendMail` — as opposed to `agent-turns.ts`'s
// projection, which records what a turn's outcome WAS after the fact.
// This registry is what lets a cancel request reach the actual in-flight
// work instead of only closing its row once whatever it was doing
// eventually finishes on its own.
//
// Deliberately process-local and workbench-keyed, mirroring
// `createTurnFreedSignal` (`./agent-turns.ts`): a workbench can have more
// than one agent turn running at once (`dispatchTurnBatch` fans out
// concurrently), so cancelling "the" in-flight turn for a workbench means
// aborting every controller registered for it, not just one.

/** The abort reason `TurnCancelRegistry.cancel` gives every controller it
 * aborts — the one thing `dispatchTurn`'s own abort-close handler checks
 * to tell a user's deliberate cancellation apart from a dispatch deadline
 * timing out, so it can settle the turn row `cancelled` rather than
 * `failed`. */
export class TurnCancelledError extends Error {
  constructor(message = "Cancelled by user") {
    super(message);
    this.name = "TurnCancelledError";
  }
}

export interface TurnCancelRegistry {
  /** Registers a fresh controller for `workbenchId`'s in-flight work.
   * The caller owns unregistering it (typically in a `finally`) once
   * that work settles on its own, win or lose. */
  register(workbenchId: string): AbortController;
  /** Removes a controller this workbench no longer needs cancelled —
   * its own work already settled, so a later `cancel` must not abort a
   * controller nothing is listening on any more. */
  unregister(workbenchId: string, controller: AbortController): void;
  /**
   * Aborts every controller currently registered for `workbenchId` with
   * a `TurnCancelledError`, and returns whether anything was actually
   * reachable this way. `false` does not mean nothing was running — a
   * turn whose `sendMail` has already resolved and moved off our call
   * stack entirely has nothing left registered here at all; settling
   * that turn's row is `cancelWorkbenchTurn`'s (`./workbench-service.ts`)
   * separate sweep, not this registry's job.
   */
  cancel(workbenchId: string): boolean;
}

export function createTurnCancelRegistry(): TurnCancelRegistry {
  const controllersByWorkbench = new Map<string, Set<AbortController>>();

  return {
    register(workbenchId) {
      const controller = new AbortController();
      const controllers =
        controllersByWorkbench.get(workbenchId) ?? new Set<AbortController>();
      controllers.add(controller);
      controllersByWorkbench.set(workbenchId, controllers);
      return controller;
    },

    unregister(workbenchId, controller) {
      const controllers = controllersByWorkbench.get(workbenchId);
      if (controllers === undefined) return;
      controllers.delete(controller);
      if (controllers.size === 0) {
        controllersByWorkbench.delete(workbenchId);
      }
    },

    cancel(workbenchId) {
      const controllers = controllersByWorkbench.get(workbenchId);
      if (controllers === undefined || controllers.size === 0) return false;
      for (const controller of controllers) {
        controller.abort(new TurnCancelledError());
      }
      return true;
    },
  };
}
