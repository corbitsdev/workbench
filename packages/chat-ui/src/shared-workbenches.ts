// Which workbenches a profile's shared-workbenches list shows (CL-5919): every
// workbench where both the signed-in viewer and the profile's subject are
// participants. Mirrors the mock's `openProfile` filter
// (`workbenchOrder.filter(members.some(subject))`, capped at 4) over the real
// `Workbench.participants` feed instead of the mock's in-memory fixture.

import { localPartOf } from "@corbits/chat/agent-address";

import type { Workbench } from "./api";

const DEFAULT_LIMIT = 4;

export type SharedWorkbenchSummary = {
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
export function sharedWorkbenchesWith(
  workbenches: readonly Workbench[],
  viewerPrincipalId: string,
  subjectAddress: string,
  limit: number = DEFAULT_LIMIT,
): readonly SharedWorkbenchSummary[] {
  return workbenches
    .filter((workbench) => {
      const hasViewer = workbench.participants.some(
        (participant) => localPartOf(participant.address) === viewerPrincipalId,
      );
      const hasSubject = workbench.participants.some(
        (participant) => participant.address === subjectAddress,
      );
      return hasViewer && hasSubject;
    })
    .slice(0, limit)
    .map((workbench) => ({
      id: workbench.id,
      title:
        workbench.title.trim().length > 0
          ? workbench.title
          : "Untitled conversation",
      memberCount: workbench.participants.length,
    }));
}
