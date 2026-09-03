// A fire's status and its cause, in the reader's words rather than the
// system's. DESIGN.md's Copy rule again: "Copy speaks the user's
// vocabulary, not the system's internals. 'Running now,' never 'in
// flight.'" — which the routines surfaces broke by badging a
// `workflow_run.status` enum and a `routine_run.triggered_by` column
// straight onto the screen.
//
// Both fall back to the raw value rather than hiding an unrecognised one:
// a status this build has never heard of is still information, and
// silently rendering nothing would be worse than rendering it plainly.

const RUN_STATUS_WORDS: Readonly<Record<string, string>> = {
  running: "Running now",
  updating: "Running now",
  completed: "Finished",
  failed: "Failed",
  error: "Failed",
  cancelled: "Cancelled",
  queued: "Waiting to start",
  pending: "Waiting to start",
};

/** A platform run status as words. */
export function runStatusLabel(status: string): string {
  return RUN_STATUS_WORDS[status] ?? status;
}

const TRIGGERED_BY_WORDS: Readonly<Record<string, string>> = {
  schedule: "On schedule",
  // The synthetic rows `markFailedFire` and the run-once create path
  // record for a launch that never produced a platform run at all.
  "schedule-failed": "Failed to start",
  "once-failed": "Failed to start",
  manual: "By hand",
  "run-now": "By hand",
  once: "On creation",
  webhook: "By webhook",
};

/** What started a fire, as words. */
export function triggeredByLabel(triggeredBy: string): string {
  return TRIGGERED_BY_WORDS[triggeredBy] ?? triggeredBy;
}

/** True when this fire never reached the platform — there is no run to
 * open, so a caller offers no trace link rather than a broken one. */
export function fireNeverStarted(triggeredBy: string): boolean {
  return triggeredBy === "schedule-failed" || triggeredBy === "once-failed";
}
