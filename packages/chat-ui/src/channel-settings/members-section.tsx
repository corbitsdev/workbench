// Members section: the human participants split out from agents (see
// AgentsSection) — invite hops into the same InviteAgentDialog the header
// action uses.

import { Button } from "@corbits/react-ui";
import { isAgentAddress } from "@corbits/chat/mentions";
import { UserPlus } from "lucide-react";

import type { ParticipantRecord } from "../api";
import { CHAT_STRINGS } from "../strings";

export function MembersSection({
  participants,
  onInvite,
}: {
  readonly participants: readonly ParticipantRecord[];
  readonly onInvite: () => void;
}) {
  const people = participants.filter((p) => !isAgentAddress(p.address));
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
            {people.map((participant) => (
              <li key={participant.address}>{participant.handle}</li>
            ))}
          </ul>
        )}
        <Button variant="outline" size="sm" onClick={onInvite}>
          <UserPlus />
          {CHAT_STRINGS.inviteAgentAction}
        </Button>
      </div>
    </div>
  );
}
