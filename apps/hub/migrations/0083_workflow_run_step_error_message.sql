-- Persist a failed step's error message AND whether its retry policy is
-- exhausted on its per-step projection row.
--
-- Needed by the dead-parked-run reconciler (a run stuck `awaiting` at a gate
-- while a sibling step is `failed` -- @intx/workflow's `areDepsResolved` only
-- checks that a dependency is terminal, so a FAILED dependency still
-- satisfies it and the dependent gate parks forever): the reconciler settles
-- the run as `failed` and must name the step that actually failed and why,
-- without re-reading the run's git event log at sweep time.
--
-- `retries_exhausted` is NOT optional colour -- it is load-bearing. The
-- native runtime's `failed` step phase is a RE-ENTRANCY MARKER between
-- attempts, not a terminal verdict: `StepFailed` is committed on every
-- attempt (interchange/packages/workflow/src/runtime/run.ts), including one
-- about to be retried after a (uncapped) backoff, and
-- `handleAttemptScheduled` re-enters that same `failed` step for its next
-- attempt. A reconciler that keys off `phase = 'failed'` alone cannot tell
-- "permanently dead" from "backing off before a retry that would have
-- succeeded" -- this column is the only durable signal that does. Defaults to
-- `false` so a pre-migration failed row (whose retry state is unknown) never
-- satisfies the reconciler's join by default -- an under-trigger, never a
-- false-positive kill.

ALTER TABLE "workflow_run_step"
  ADD COLUMN "error_message" text,
  ADD COLUMN "retries_exhausted" boolean NOT NULL DEFAULT false;
