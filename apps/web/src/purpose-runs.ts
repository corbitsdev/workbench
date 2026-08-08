// The hub's runs listing carries every folded interactive run,
// including the chat anchor machinery's channel hosts. Their workflow
// definitions are named by `@corbits/chat`'s channel-host naming
// contract, so this filter — applied by every screen that shows
// workflow runs or the definitions behind them — is the same predicate
// the platform adapter mints those names with, never a hardcoded list.

import { isChannelHostDefinitionName } from "@corbits/chat/channel-host-naming";

import type { WorkflowRun } from "./api";

export function purposeRuns(
  runs: readonly WorkflowRun[],
): readonly WorkflowRun[] {
  return runs.filter((run) => !isChannelHostDefinitionName(run.definitionName));
}
