// Finding an existing 1:1 by participant address — the read half of the
// "open-or-create" pattern the profile card's Message action needs (CL-5914).
// A profile subject is identified by address, not by a workbench title.

import type { Workbench } from "./api";

export function findDirectWorkbenchWith(
  workbenches: readonly Workbench[],
  subjectAddress: string,
): Workbench | undefined {
  return workbenches.find((workbench) =>
    workbench.participants.some(
      (participant) => participant.address === subjectAddress,
    ),
  );
}
