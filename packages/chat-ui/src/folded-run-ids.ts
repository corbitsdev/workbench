// The complete set of folded/chat workflowRun ids a tenant holds,
// derived from its channels — both channel-host anchors (a channel's
// own id) and invited-agent runs (every participant's address, whose
// local part is the invited run's own instance id). Needed because
// `packages/folded-runs/src/launch.ts` self-anchors every folded run
// (`anchorRunId === id`, matching a real deployment's shape — see that
// file's comment for why), so any hub route selecting on that
// predicate (e.g. `vendor/intx/hub-api/src/routes/runs.ts`'s tenant
// run list) now includes folded runs too. `isChannelHostDefinitionName`
// alone only catches channel hosts, not invited agents (which launch
// under a real, user-authored `definitionId` — see
// `packages/chat/src/platform-adapter.ts`'s `launchInvite`), so a
// surface that wants "real top-level deployments only" needs this
// run-id-keyed set as well.

import { localPartOf } from "@corbits/chat/agent-address";
import type { Channel } from "./api";

export function foldedRunIdsFromChannels(
  channels: readonly Channel[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const channel of channels) {
    ids.add(channel.id);
    for (const participant of channel.participants) {
      ids.add(localPartOf(participant.address));
    }
  }
  return ids;
}
