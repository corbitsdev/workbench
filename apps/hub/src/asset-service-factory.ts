// The hub's asset-service composition, factored into a typed factory
// (CL-6404) so it has exactly two callers and one implementation: hub
// boot (`index.ts`) and the eval harness (`scripts/evals-run.ts`),
// which needs to read a scratch hub's agent-repo assets — the same
// data dir, the same store construction — to capture world snapshots.
// Never a parallel implementation: this IS the boot wiring.
import {
  createAgentRepoStore,
  createAssetService,
  type AgentRepoStore,
  type AssetService,
} from "@intx/hub-sessions";
import { generateKeyPair } from "@intx/crypto";
import type { DB } from "@intx/db";
import { assertHubDataDirGitSafety } from "./hub-data-dir-git-safety";

// Host policy constant, not configuration — shared by boot (tool-package
// registry routing) and asset-service construction.
export const REGISTRIES = new Map([
  ["npmjs", { url: "https://registry.npmjs.org" }],
]);

export interface BootAssetWiring {
  readonly signingKey: Awaited<ReturnType<typeof generateKeyPair>>;
  readonly agentRepoStore: AgentRepoStore;
  readonly assetService: AssetService;
}

/**
 * Builds the signing key, agent-repo store, and asset service the hub
 * boots with, over `dataDir`. A second caller pointing at a running
 * hub's own data dir gets a read-equivalent `AssetService` over the
 * same on-disk repos (the fresh signing key only ever signs writes,
 * which a snapshot reader never performs).
 */
export async function createBootAssetWiring(args: {
  db: DB["db"];
  dataDir: string;
  allowGitInsideWorkTree?: boolean;
}): Promise<BootAssetWiring> {
  assertHubDataDirGitSafety(
    args.dataDir,
    args.allowGitInsideWorkTree === true ? { allowInsideWorkTree: true } : {},
  );
  const signingKey = await generateKeyPair();
  const agentRepoStore = createAgentRepoStore({
    dataDir: args.dataDir,
    signingKey,
  });
  const assetService = createAssetService({
    db: args.db,
    repoStore: agentRepoStore.repoStore,
    reservedPackageRegistryNames: new Set(REGISTRIES.keys()),
  });
  return { signingKey, agentRepoStore, assetService };
}
