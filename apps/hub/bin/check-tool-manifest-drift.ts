// Fail-fast guard: the committed `packages/tool-manifest/src/generated/tool-manifest-index.ts`
// must match what `bun run build:tool-manifests` would produce from the live
// package manifests right now. `canonicalizeToolNames` (packages/agent-core/src/tool-names.ts)
// builds its lookup table from the COMMITTED index, not a fresh regeneration —
// so a stale index silently passes an unknown tool name through unprefixed
// instead of expanding it to `<factoryId>:<name>`, and that bare name gets
// baked into a deployed workflow def by `build:workflow-defs`. Wired into
// `bun run lint` (root package.json) so drift is caught before a commit ships,
// the same way `scripts/preflight-intx-src.ts` guards the resolve condition.

import {
  loadCommittedToolManifestFactories,
  sortFactoryManifests,
  type ToolFactoryManifest,
} from "@workbench/tool-manifest";
import { collectToolFactoryManifests } from "./build-tool-manifests";

export interface ToolManifestDriftResult {
  hasDrift: boolean;
  liveFactoryIds: string[];
  committedFactoryIds: string[];
}

export function findToolManifestDrift(
  live: readonly ToolFactoryManifest[],
  committed: readonly ToolFactoryManifest[],
): ToolManifestDriftResult {
  const sortedLive = sortFactoryManifests([...live]);
  const sortedCommitted = sortFactoryManifests([...committed]);
  return {
    hasDrift: JSON.stringify(sortedLive) !== JSON.stringify(sortedCommitted),
    liveFactoryIds: sortedLive.map((f) => f.factoryId),
    committedFactoryIds: sortedCommitted.map((f) => f.factoryId),
  };
}

export function renderDriftReport(result: ToolManifestDriftResult): string {
  return [
    "check-tool-manifest-drift: the committed tool-manifest index does not match",
    "the live package manifests.",
    "",
    `Live factories (${result.liveFactoryIds.length}): ${result.liveFactoryIds.join(", ")}`,
    `Committed factories (${result.committedFactoryIds.length}): ${result.committedFactoryIds.join(", ")}`,
    "",
    "Fix: run `bun run build:tool-manifests` in apps/hub and commit the",
    "regenerated packages/tool-manifest/src/generated/tool-manifest-index.ts",
    "and apps/hub/generated/tool-manifests/index.json.",
  ].join("\n");
}

async function main(): Promise<void> {
  const live = await collectToolFactoryManifests();
  const committed = loadCommittedToolManifestFactories();
  const result = findToolManifestDrift(live, committed);
  if (result.hasDrift) {
    process.stderr.write(renderDriftReport(result) + "\n");
    process.exit(1);
  }
  process.stdout.write(
    `check-tool-manifest-drift: ok (${result.liveFactoryIds.length} factories)\n`,
  );
}

if (import.meta.main) {
  await main();
}
