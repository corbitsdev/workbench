// The hub's runs listing carries every folded interactive run,
// including the chat anchor machinery's channel hosts. Their workflow
// definitions are named by `@corbits/chat`'s channel-host naming
// contract, so this filter — applied by every screen that shows
// workflow runs or the definitions behind them — is the same predicate
// the platform adapter mints those names with, never a hardcoded list.

import { isChannelHostDefinitionName } from "@corbits/chat/channel-host-naming";

import type { WorkflowRun } from "./api";

/**
 * `foldedRunIds` additionally excludes invited-agent chat runs, which
 * self-anchor like a real deployment (see `packages/folded-runs/src/
 * launch.ts`) and launch under a real `definitionId`
 * `isChannelHostDefinitionName` never catches. Defaults to an empty set
 * for a route this filter runs over that never surfaces self-anchored
 * folded runs in the first place (e.g. `/me/workflows/runs`, which
 * selects `anchorRunId IS NULL`).
 */
export function purposeRuns(
  runs: readonly WorkflowRun[],
  foldedRunIds: ReadonlySet<string> = new Set(),
): readonly WorkflowRun[] {
  return runs.filter(
    (run) =>
      !isChannelHostDefinitionName(run.definitionName) &&
      !foldedRunIds.has(run.id),
  );
}
