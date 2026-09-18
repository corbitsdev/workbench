// Same-asset definition edits are read-modify-write; this module serializes
// concurrent writers and retries the loser against the latest snapshot. The
// lock is an in-process promise chain keyed by asset id — correct only
// because hub is a single replica, not safe across multiple.

import type { AssetService } from "@intx/hub-sessions";

import { readAgentDefinitionWorkflowJson } from "./definition-asset";

const MAX_STALE_SNAPSHOT_RETRIES = 8;

const writeChains = new Map<string, Promise<void>>();

async function withAssetWriteLock<T>(assetId: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(assetId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeChains.set(
    assetId,
    previous.then(() => held),
  );
  try {
    await previous;
    return await fn();
  } finally {
    release();
  }
}

export type PreparedAgentAssetWrite<T> = {
  workflowJson: string;
  message: string;
  result: T;
};

export type CommitLatestAgentAssetSnapshotArgs<T> = {
  assetService: AssetService;
  assetId: string;
  operation: string;
  prepare: (snapshot: string) => Promise<PreparedAgentAssetWrite<T>>;
  write: (prepared: { workflowJson: string; message: string }) => Promise<void>;
};

/** Applies one mutation against the definition's current asset, retrying
 * when a concurrent writer moved the snapshot between read and write. */
export async function commitLatestAgentAssetSnapshot<T>(
  args: CommitLatestAgentAssetSnapshotArgs<T>,
): Promise<T> {
  for (let remaining = MAX_STALE_SNAPSHOT_RETRIES; remaining > 0; remaining -= 1) {
    const snapshot = await readAgentDefinitionWorkflowJson(args.assetService, args.assetId);
    const prepared = await args.prepare(snapshot);
    const wrote = await withAssetWriteLock(args.assetId, async () => {
      const latest = await readAgentDefinitionWorkflowJson(args.assetService, args.assetId);
      if (latest !== snapshot) return false;
      await args.write({
        workflowJson: prepared.workflowJson,
        message: prepared.message,
      });
      return true;
    });
    if (wrote) return prepared.result;
  }
  throw new Error(
    `${args.operation} for asset ${args.assetId} conflicted after ${String(MAX_STALE_SNAPSHOT_RETRIES)} retries`,
  );
}
