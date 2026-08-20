// Adds an already-launched run's address to a workbench's participant list.
// Membership is the one thing the chat orchestrator keys on to post a
// run's `connector.reply` into a workbench (see `chat-orchestrator.ts`'s
// `resolveMemberWorkbenches`), so a routine's run delivering into its
// workbench is exactly this join — no second posting path. Unlike
// `launchAndJoinAgent`, the run is launched elsewhere (`@corbits/routines`'
// launcher port) and no join event is posted: a routine's arrival in the
// workbench is its first reply, not a "joined" announcement.
import { addParticipant, parseParticipants } from "./participants";
import type { ChatStore } from "./store";

export type JoinRunParticipantDeps = {
  readonly store: Pick<
    ChatStore,
    "getWorkbenchSettings" | "updateWorkbenchSettings"
  >;
};

export type JoinRunParticipantInput = {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly principalId: string;
  readonly address: string;
  readonly handle: string;
};

export async function joinRunParticipant(
  deps: JoinRunParticipantDeps,
  input: JoinRunParticipantInput,
): Promise<void> {
  const row = await deps.store.getWorkbenchSettings(
    input.tenantId,
    input.workbenchId,
  );
  if (row === undefined) {
    throw new Error(
      `no workbench "${input.workbenchId}" in tenant "${input.tenantId}"`,
    );
  }
  await deps.store.updateWorkbenchSettings({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    settings: {
      ...row.settings,
      "chat/participants": addParticipant(
        parseParticipants(row.settings["chat/participants"]),
        input.address,
        input.handle,
      ),
    },
    updatedBy: input.principalId,
  });
}
