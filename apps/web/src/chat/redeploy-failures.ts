// Assets whose redeploy threw this session. Their old dead run is still the
// latest one, so without this every remount would redeploy again.
const failed = new Set<string>();

export const markRedeployFailed = (assetId: string): void => void failed.add(assetId);
export const clearRedeployFailure = (assetId: string): void => void failed.delete(assetId);
export const hasRedeployFailed = (assetId: string): boolean => failed.has(assetId);
