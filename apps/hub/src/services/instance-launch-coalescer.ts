// The single per-instance in-flight primitive at the `launchAgentSession`
// boundary. Every launch entry point funnels through this one map — the
// explicit `POST /instances/:id/sessions` route, the background wedge sweep
// (via `runDedupedRelaunch`), and any future caller — so concurrent launches
// for one instance coalesce onto a single `launchAgentSession` regardless of
// which path started it.
//
// Why this must be shared: two racing launches for the same instance let the
// loser's failure teardown end/delete the instance row while the winner's
// deploy ack is still in flight, at which point interchange's ack listener
// throws "No active instance found for deploy ack" and the launch 503s with
// phase=provision. The frontend fires the explicit route proactively (and
// sometimes twice); the wedge sweep relaunches from a separate schedule. Only a
// map that both share collapses cross-path races onto one launch.
//
// The guarantee is process-local, which holds only while the hub runs
// single-replica. A multi-replica hub would need a distributed lock; this map
// does not provide one.
const instanceLaunchInFlight = new Map<string, Promise<unknown>>();

/** Test seam: drop all in-flight launch coalescing state. */
export function resetInstanceLaunchCoalescer(): void {
  instanceLaunchInFlight.clear();
}

/**
 * Coalesce concurrent launches for one instance. If a launch is already in
 * flight for `instanceId`, returns the existing promise without invoking
 * `launch`; both callers observe the same result (or the same failure). The
 * in-flight entry is cleared once the launch settles, so a subsequent call —
 * whether after success or failure — launches fresh.
 */
export function coalesceInstanceLaunch<T>(
  instanceId: string,
  launch: () => Promise<T>,
): Promise<T> {
  const existing = instanceLaunchInFlight.get(instanceId) as
    | Promise<T>
    | undefined;
  if (existing) return existing;

  const attempt = launch().finally(() => {
    instanceLaunchInFlight.delete(instanceId);
  });
  instanceLaunchInFlight.set(instanceId, attempt);
  return attempt;
}
