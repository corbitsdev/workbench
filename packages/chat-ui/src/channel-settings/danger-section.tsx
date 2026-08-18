// Danger zone section: archive is not wired to a real endpoint yet — same
// callout copy the dialog shipped, just re-housed.

import { CHAT_STRINGS } from "../strings";

export function DangerSection() {
  return (
    <div className="channel-settings-pane">
      <div className="chat-settings-callout chat-settings-callout-danger">
        <span className="chat-settings-callout-label">
          {CHAT_STRINGS.channelSettingsArchiveTitle}
        </span>
        <p>{CHAT_STRINGS.channelSettingsArchiveBody}</p>
      </div>
    </div>
  );
}
