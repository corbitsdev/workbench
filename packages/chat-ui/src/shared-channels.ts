// Which channels a profile's shared-channels list shows (CL-5919): every
// channel where both the signed-in viewer and the profile's subject are
// participants. Mirrors the mock's `openProfile` filter
// (`channelOrder.filter(members.some(subject))`, capped at 4) over the real
// `Channel.participants` feed instead of the mock's in-memory fixture.

import { localPartOf } from "@corbits/chat/agent-address";

import type { Channel } from "./api";

const DEFAULT_LIMIT = 4;

export type SharedChannelSummary = {
  readonly id: string;
  readonly title: string;
  readonly memberCount: number;
};

/**
 * `viewerPrincipalId` matches a participant by address local part — a
 * sender/participant address's local part IS the owning principal's id (see
 * `packages/chat-ui/src/timeline.tsx`'s `CurrentUser` doc comment) — while
 * `subjectAddress` matches by exact address, since a `ProfileSubject` always
 * carries the full address it was opened from.
 */
export function sharedChannelsWith(
  channels: readonly Channel[],
  viewerPrincipalId: string,
  subjectAddress: string,
  limit: number = DEFAULT_LIMIT,
): readonly SharedChannelSummary[] {
  return channels
    .filter((channel) => {
      const hasViewer = channel.participants.some(
        (participant) => localPartOf(participant.address) === viewerPrincipalId,
      );
      const hasSubject = channel.participants.some(
        (participant) => participant.address === subjectAddress,
      );
      return hasViewer && hasSubject;
    })
    .slice(0, limit)
    .map((channel) => ({
      id: channel.id,
      title:
        channel.title.trim().length > 0
          ? channel.title
          : "Untitled conversation",
      memberCount: channel.participants.length,
    }));
}
