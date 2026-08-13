// Agents section: the agent participants split out from humans (see
// MembersSection), plus the autonomy callout — per-channel autonomy
// overrides are draft UI until their store lands.

import { Button } from "@corbits/react-ui";
import { isAgentAddress } from "@corbits/chat/mentions";
import { UserPlus } from "lucide-react";

import type { ParticipantRecord } from "../api";
import { CHAT_STRINGS } from "../strings";

export function AgentsSection({
  participants,
  onInvite,
}: {
  readonly participants: readonly ParticipantRecord[];
  readonly onInvite: () => void;
}) {
  const agents = participants.filter((p) => isAgentAddress(p.address));
  return (
    <div className="channel-settings-pane">
      <div className="chat-settings-field">
        <span>{CHAT_STRINGS.channelSettingsAgentsLabel}</span>
        {agents.length === 0 ? (
          <p className="chat-settings-field-hint">
            {CHAT_STRINGS.channelSettingsNoAgents}
          </p>
        ) : (
          <ul className="chat-settings-participants-list">
            {agents.map((participant) => (
              <li key={participant.address}>@{participant.handle}</li>
            ))}
          </ul>
        )}
        <Button variant="outline" size="sm" onClick={onInvite}>
          <UserPlus />
          {CHAT_STRINGS.inviteAgentAction}
        </Button>
      </div>
      <div className="chat-settings-callout">
        <strong>{CHAT_STRINGS.channelSettingsAutonomyTitle}</strong>
        <p>{CHAT_STRINGS.channelSettingsAutonomyBody}</p>
      </div>
    </div>
  );
}
