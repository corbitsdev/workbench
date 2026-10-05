// Assets whose redeploy threw this session. Their old dead run is still the
// latest one, so without this every remount would redeploy again.
const failed = new Set<string>();

export const markRedeployFailed = (assetId: string): void => void failed.add(assetId);
export const clearRedeployFailure = (assetId: string): void => void failed.delete(assetId);
export const hasRedeployFailed = (assetId: string): boolean => failed.has(assetId);

const inFlight = new Set<string>();

/** One surface at a time redeploys an asset on its own: false when another
 * already holds it. */
export function claimAutoRedeploy(assetId: string): boolean {
  if (inFlight.has(assetId)) return false;
  inFlight.add(assetId);
  return true;
}

export const releaseAutoRedeploy = (assetId: string): void => void inFlight.delete(assetId);
