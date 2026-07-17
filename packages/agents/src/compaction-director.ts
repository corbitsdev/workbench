import { contextWindowForModel } from "@workbench/catalog";
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorDirector,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";
import { SUMMARIZE_COMPACTOR_NAME } from "./summarize-compactor";

/**
 * Fraction of a model's context window at which `wrapDirectorWithCompaction`
 * inserts a `compact` action ahead of the next `infer`. 80% leaves enough
 * headroom for the compaction call itself (the summarize compactor's own
 * inference turn) plus the model's next reply to still fit under the hard
 * context ceiling.
 */
export const COMPACTION_TRIGGER_THRESHOLD = 0.8;

export type CompactionDirectorOptions = {
  /** Resolves a model id to its context window. Defaults to the catalog. */
  windowFor?: (modelId: string) => number;
  /** Usage ratio at which compaction fires. Defaults to 0.8. */
  threshold?: number;
};

function toArray(actions: ReactorAction | ReactorAction[]): ReactorAction[] {
  return Array.isArray(actions) ? actions : [actions];
}

/**
 * Wraps an inner director with an 80%-of-context-window compaction trigger,
 * applied uniformly across every Workbench agent regardless of its own
 * director. Below the threshold this delegates entirely to the inner
 * director's decisions.
 *
 * `ReactorState.lastCycleUsage` reports the *pre-compact* prompt size for
 * one extra cycle after a compaction fires (compaction happens between
 * cycles, so the usage that triggered it is still the "last" reading until
 * the next inference call actually runs against the shrunk history). Firing
 * again on that stale reading would compact every single cycle once the
 * ratio ever crosses the threshold. A closure latch suppresses re-firing on
 * that one stale reading.
 *
 * The latch must not wedge compaction forever if a compaction fails or
 * doesn't shrink the working set enough to drop the ratio below threshold:
 * once latched, the *next* breach consumes the latch (clears it and skips
 * firing, to absorb the one stale reading) rather than staying latched
 * indefinitely — so a persistent breach retries on the cycle after that
 * instead of never firing again.
 */
export function wrapDirectorWithCompaction(
  inner: ReactorDirector,
  opts: CompactionDirectorOptions = {},
): ReactorDirector {
  const windowFor = opts.windowFor ?? contextWindowForModel;
  const threshold = opts.threshold ?? COMPACTION_TRIGGER_THRESHOLD;
  let latched = false;

  return {
    async decide(
      event: ReactorInboundEvent,
      state: ReactorState,
      capabilities: ReactorCapabilities,
    ): Promise<ReactorAction[]> {
      const actions = toArray(await inner.decide(event, state, capabilities));

      if (state.lastCycleUsage === null || state.lastCycleSource === null) {
        return actions;
      }

      const window = windowFor(state.lastCycleSource.model);
      const ratio = state.lastCycleUsage.input / window;

      if (ratio < threshold) {
        latched = false;
        return actions;
      }

      const inferIndex = actions.findIndex((action) => action.type === "infer");
      if (inferIndex === -1) {
        return actions;
      }

      if (latched) {
        // A prior compaction fired but the usage reading is still stale
        // (see the class doc) or the compaction did not shrink the working
        // set enough. Consume this cycle as the one-cycle grace period
        // rather than staying latched forever — a persistent breach will
        // fire again on the cycle after this one.
        latched = false;
        return actions;
      }

      latched = true;
      const compactAction = capabilities.compact(
        SUMMARIZE_COMPACTOR_NAME,
        `context-window-${Math.round(ratio * 100)}pct`,
      );
      const result = [...actions];
      result.splice(inferIndex, 0, compactAction);
      return result;
    },
  };
}
