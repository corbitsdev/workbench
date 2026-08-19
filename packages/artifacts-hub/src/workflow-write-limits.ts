// Shared protections for every workflow-run-authenticated write surface
// (workflow-artifacts here, workflow-memory in `apps/hub/src/
// memory-mount.ts`): a per-run rate limit and a per-payload character
// cap. Both surfaces authenticate a workflow-process child the same way
// (`./workflow-auth.ts`'s `WorkflowRunAuthenticator`) and both need the
// same two backstops a browser caller never needs, since only a
// runaway/looping agent — never a human clicking a button — can flood a
// write endpoint. Extracted here (CL-6296) so a third copy never appears:
// this package is already the generic home of `WorkflowRunAuthenticator`
// and run-scoped-caller machinery.
//
// A finalized turn can legitimately write a handful of entries (one per
// persisted artifact/memory note, plus a digest) in one burst; 30/minute
// per run comfortably covers that while still catching a runaway loop
// before it floods storage. 64k characters is generous for any honest
// artifact body or memory note while still catching a model that pastes
// an entire tool result or file verbatim instead of summarizing it.
export const MAX_WORKFLOW_WRITE_TEXT_CHARS = 64_000;
export const MAX_WORKFLOW_WRITES_PER_RUN_PER_MINUTE = 30;

const RATE_WINDOW_MS = 60_000;

export type RunWriteRateLimiter = {
  allow(runId: string): boolean;
};

/**
 * In-process sliding-window rate limiter, closed over per caller —
 * resets on process restart, which is fine: unlike a durable
 * redelivery-dedup claim, a rate bound only needs to hold within one
 * process's uptime, never across it. Per-process also means per-replica:
 * N host replicas give one run an effective N × `maxPerWindow` budget,
 * since each replica counts only what it personally handled — a known
 * fail-open gap, not a fail-closed one, so it under-limits rather than
 * wrongly rejecting a caller a sibling replica hasn't seen yet. Fixing
 * that would need a shared store (e.g. Redis) and is out of scope here.
 */
export function createRunWriteRateLimiter(
  maxPerWindow: number = MAX_WORKFLOW_WRITES_PER_RUN_PER_MINUTE,
): RunWriteRateLimiter {
  const timestampsByRunId = new Map<string, number[]>();
  return {
    allow(runId: string): boolean {
      const now = Date.now();
      const cutoff = now - RATE_WINDOW_MS;
      const recent = (timestampsByRunId.get(runId) ?? []).filter(
        (timestamp) => timestamp > cutoff,
      );
      if (recent.length >= maxPerWindow) {
        timestampsByRunId.set(runId, recent);
        return false;
      }
      recent.push(now);
      timestampsByRunId.set(runId, recent);
      return true;
    },
  };
}

/** The bearer-token + run-address pair every workflow-run HTTP surface reads off the request. */
export function readWorkflowRunCredentials(headers: {
  get(name: string): string | null | undefined;
}): { token: string; address: string } {
  const authHeader = headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";
  const address = headers.get("x-workflow-run-address") ?? "";
  return { token, address };
}
