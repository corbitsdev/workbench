// Danger zone section: archive is not wired to a real endpoint yet — same
// callout copy the dialog shipped, just re-housed.

import { CHAT_STRINGS } from "../strings";

export function DangerSection() {
  return (
    <div className="channel-settings-pane" role="tabpanel">
      <div className="chat-settings-callout chat-settings-callout-danger">
        <strong>{CHAT_STRINGS.channelSettingsArchiveTitle}</strong>
        <p>{CHAT_STRINGS.channelSettingsArchiveBody}</p>
      </div>
    </div>
  );
}
