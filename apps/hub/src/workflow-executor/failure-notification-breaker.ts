import { getLogger } from "@intx/log";

const log = getLogger(["workflow-exec", "failure-notification-breaker"]);

/**
 * Repeat-failure suppression for terminal-run failure mail (CL-3517 review).
 * A workflow that fails on every run — most acutely a daily scheduled trigger
 * wedged on a persistent fault — would otherwise mail the owner a failure notice
 * on every fire, training them to ignore the inbox. This tracks CONSECUTIVE
 * failure notifications per delivery key and, after `MAX_CONSECUTIVE_FAILURE_MAILS`
 * mails, stops delivering further failure mail for that key until a SUCCESS for
 * the same key resets it.
 *
 * Durability: process-local, matching `relaunch-breaker.ts` consciously. A hub
 * restart resets the counters, which is the correct behaviour — a fresh process
 * re-warns the owner once (up to the cap) rather than silently swallowing a fault
 * whose suppression state was learned by a since-replaced process. The storm this
 * guards against (repeated failures within one process lifetime) is fully
 * suppressed; daily scheduled fires accumulate in-process across days while the
 * hub stays up, and a restart's re-warn is an acceptable, bounded cost — not
 * worth a persisted table and its migration/GC burden.
 */

// Chosen to match relaunch-breaker's "a fresh process retries once" spirit: a
// handful of warnings is enough signal; beyond that the mail is noise.
export const MAX_CONSECUTIVE_FAILURE_MAILS = 3;

type FailureNotifyState = {
  // Failure mails delivered in a row for this key with no interleaving success.
  consecutiveFailures: number;
};

const failures = new Map<string, FailureNotifyState>();

/** Test seam: drop all suppression state. */
export function resetFailureNotificationBreaker(): void {
  failures.clear();
}

/**
 * Delivery key for failure-mail suppression. Keyed on the WORKFLOW KIND, not the
 * deploymentId: per-run deployments are single-use (CL-2582), so a deploymentId
 * is unique per run and would make every failure a fresh key — suppression would
 * never engage. The kind is the stable identity of "the same workflow failing
 * again". Scoped by tenant + owner so one member's storm never suppresses
 * another's mail.
 */
export function failureNotificationKey(
  tenantId: string,
  workflowKind: string,
  ownerPrincipalId: string,
): string {
  return `${tenantId}\0${workflowKind}\0${ownerPrincipalId}`;
}

export type FailureNotifyDecision = {
  // Whether this failure mail should be delivered at all.
  deliver: boolean;
  // True only on the LAST mail before suppression engages — the body should tell
  // the owner further failure notifications are paused until the next success.
  pausedNotice: boolean;
};

/**
 * Record a failure for `key` and decide whether to deliver its mail. The first
 * `MAX_CONSECUTIVE_FAILURE_MAILS - 1` deliver plainly; the Nth delivers with a
 * `pausedNotice`; every failure after that is suppressed. Stateful: each call
 * advances the consecutive-failure count for the key.
 */
export function noteFailureNotification(key: string): FailureNotifyDecision {
  const consecutiveFailures = (failures.get(key)?.consecutiveFailures ?? 0) + 1;
  failures.set(key, { consecutiveFailures });

  if (consecutiveFailures < MAX_CONSECUTIVE_FAILURE_MAILS) {
    return { deliver: true, pausedNotice: false };
  }
  if (consecutiveFailures === MAX_CONSECUTIVE_FAILURE_MAILS) {
    log.info("Failure-notification cap reached; pausing after this mail", {
      key,
      consecutiveFailures,
    });
    return { deliver: true, pausedNotice: true };
  }
  log.debug("Failure notification suppressed (cap reached)", {
    key,
    consecutiveFailures,
  });
  return { deliver: false, pausedNotice: false };
}

/**
 * Record a success for `key`, clearing any accumulated failure count so the next
 * failure re-arms the full warning budget.
 */
export function noteSuccessNotification(key: string): void {
  failures.delete(key);
}
