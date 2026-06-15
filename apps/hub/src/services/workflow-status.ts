/**
 * Canonical mapping from a persisted `workflow_run.status` (DB status) to the
 * session-level status the API exposes. This is a dependency-free leaf so both
 * the orchestration and generation services can import the single definition —
 * never duplicate the map, or the two paths can return different statuses for
 * the same row.
 */
export function mapDbStatusToSessionStatus(status: string): string {
  const map: Record<string, string> = {
    pending: 'pending',
    analyzing: 'analyzing',
    // 'running' is the post-analyze state: pain points are ready and the user
    // is choosing what to generate. It is NOT active generation.
    running: 'ready',
    generating: 'generating',
    reviewing: 'reviewing',
    done: 'done',
    failed: 'failed',
  };
  const mapped = map[status];
  if (mapped === undefined) {
    throw new Error(`Unknown workflow status: ${status}`);
  }
  return mapped;
}
