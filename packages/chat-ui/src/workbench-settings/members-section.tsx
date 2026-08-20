// Members section: the human participants split out from agents (see
// AgentsSection) — invite hops into the same InviteAgentDialog the header
// action uses. Each row also carries a Remove affordance (CL-6122): a
// second-click `ConfirmButton` that drops the member's participant
// record server-side (`removeWorkbenchParticipant`), disabled for the
// signed-in viewer's own row — there is no "leave" flow yet, so removing
// yourself here would strand you outside a workbench you can't rejoin
// without another member re-inviting you.

import { useState } from "react";
import { Button, ConfirmButton } from "@corbits/react-ui";
import { isAgentAddress } from "@corbits/chat/mentions";
import { UserPlus } from "@corbits/icons";

import type { ParticipantRecord } from "../api";
import { describeChatError, removeWorkbenchParticipant } from "../api";
import { CHAT_STRINGS } from "../strings";

export function MembersSection({
  tenantId,
  workbenchId,
  participants,
  currentUserPrincipalId,
  onInvite,
  onParticipantsChanged,
}: {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly participants: readonly ParticipantRecord[];
  /** The signed-in viewer's own principal id, so their own row's Remove
   * button can be disabled — omitted, no row is treated as "you". */
  readonly currentUserPrincipalId?: string;
  readonly onInvite: () => void;
  /** Fired after a successful removal so the host can refetch the
   * workbench's participants — this section never trusts an optimistic
   * local edit for who still belongs to the workbench. */
  readonly onParticipantsChanged: () => void;
}) {
  const [removingAddress, setRemovingAddress] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const people = participants.filter((p) => !isAgentAddress(p.address));

  function handleRemove(address: string) {
    setRemovingAddress(address);
    setRowError(null);
    removeWorkbenchParticipant(tenantId, workbenchId, address)
      .then(() => onParticipantsChanged())
      .catch((cause: unknown) =>
        setRowError(
          describeChatError(cause, CHAT_STRINGS.workbenchSettingsRemoveError),
        ),
      )
      .finally(() => setRemovingAddress(null));
  }

  return (
    <div className="workbench-settings-pane">
      <div className="chat-settings-field">
        <span>{CHAT_STRINGS.workbenchSettingsPeopleLabel}</span>
        {people.length === 0 ? (
          <p className="chat-settings-field-hint">
            {CHAT_STRINGS.workbenchSettingsNoPeople}
          </p>
        ) : (
          <ul className="chat-settings-participants-list">
            {people.map((participant) => {
              const isSelf = participant.address === currentUserPrincipalId;
              const busy = removingAddress === participant.address;
              return (
                <li
                  key={participant.address}
                  className="chat-settings-participant-row"
                >
                  <div className="chat-settings-participant-row-main">
                    <span>{participant.handle}</span>
                    <ConfirmButton
                      variant="outline"
                      size="sm"
                      confirmLabel={
                        CHAT_STRINGS.workbenchSettingsRemoveConfirmLabel
                      }
                      disabled={isSelf || busy}
                      title={
                        isSelf
                          ? CHAT_STRINGS.workbenchSettingsRemoveSelfHint
                          : undefined
                      }
                      onConfirm={() => handleRemove(participant.address)}
                    >
                      {busy
                        ? CHAT_STRINGS.workbenchSettingsRemoving
                        : CHAT_STRINGS.workbenchSettingsRemoveAction}
                    </ConfirmButton>
                  </div>
                  <p className="chat-settings-field-hint">
                    {isSelf
                      ? CHAT_STRINGS.workbenchSettingsRemoveSelfHint
                      : CHAT_STRINGS.workbenchSettingsRemoveConsequence}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        {rowError !== null ? (
          <p className="chat-dialog-error" role="alert">
            {rowError}
          </p>
        ) : null}
        <Button variant="outline" size="sm" onClick={onInvite}>
          <UserPlus />
          {CHAT_STRINGS.inviteAgentAction}
        </Button>
      </div>
    </div>
  );
}
