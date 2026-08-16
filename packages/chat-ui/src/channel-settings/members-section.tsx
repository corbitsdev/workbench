// Members section: the human participants split out from agents (see
// AgentsSection) — invite hops into the same InviteAgentDialog the header
// action uses. Each row also carries a Remove affordance (CL-6122): a
// second-click `ConfirmButton` that drops the member's participant
// record server-side (`removeChannelParticipant`), disabled for the
// signed-in viewer's own row — there is no "leave" flow yet, so removing
// yourself here would strand you outside a workbench you can't rejoin
// without another member re-inviting you.

import { useState } from "react";
import { Button, ConfirmButton } from "@corbits/react-ui";
import { isAgentAddress } from "@corbits/chat/mentions";
import { UserPlus } from "lucide-react";

import type { ParticipantRecord } from "../api";
import { describeChatError, removeChannelParticipant } from "../api";
import { CHAT_STRINGS } from "../strings";

export function MembersSection({
  tenantId,
  channelId,
  participants,
  currentUserPrincipalId,
  onInvite,
  onParticipantsChanged,
}: {
  readonly tenantId: string;
  readonly channelId: string;
  readonly participants: readonly ParticipantRecord[];
  /** The signed-in viewer's own principal id, so their own row's Remove
   * button can be disabled — omitted, no row is treated as "you". */
  readonly currentUserPrincipalId?: string;
  readonly onInvite: () => void;
  /** Fired after a successful removal so the host can refetch the
   * channel's participants — this section never trusts an optimistic
   * local edit for who still belongs to the workbench. */
  readonly onParticipantsChanged: () => void;
}) {
  const [removingAddress, setRemovingAddress] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const people = participants.filter((p) => !isAgentAddress(p.address));

  function handleRemove(address: string) {
    setRemovingAddress(address);
    setRowError(null);
    removeChannelParticipant(tenantId, channelId, address)
      .then(() => onParticipantsChanged())
      .catch((cause: unknown) =>
        setRowError(
          describeChatError(cause, CHAT_STRINGS.channelSettingsRemoveError),
        ),
      )
      .finally(() => setRemovingAddress(null));
  }

  return (
    <div className="channel-settings-pane">
      <div className="chat-settings-field">
        <span>{CHAT_STRINGS.channelSettingsPeopleLabel}</span>
        {people.length === 0 ? (
          <p className="chat-settings-field-hint">
            {CHAT_STRINGS.channelSettingsNoPeople}
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
                        CHAT_STRINGS.channelSettingsRemoveConfirmLabel
                      }
                      disabled={isSelf || busy}
                      title={
                        isSelf
                          ? CHAT_STRINGS.channelSettingsRemoveSelfHint
                          : undefined
                      }
                      onConfirm={() => handleRemove(participant.address)}
                    >
                      {busy
                        ? CHAT_STRINGS.channelSettingsRemoving
                        : CHAT_STRINGS.channelSettingsRemoveAction}
                    </ConfirmButton>
                  </div>
                  <p className="chat-settings-field-hint">
                    {isSelf
                      ? CHAT_STRINGS.channelSettingsRemoveSelfHint
                      : CHAT_STRINGS.channelSettingsRemoveConsequence}
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
