// Process-wide drain flag set on SIGTERM/SIGINT (Railway redeploy). During
// Railway's deployment-overlap window internal DNS can still route a
// reconnecting sidecar to this replica while it is shutting down, so a new
// WebSocket upgrade must be refused immediately instead of hanging or being
// accepted by a dying process — see createSidecarWsDrainGuard.
let draining = false;

export function beginDrain(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}
