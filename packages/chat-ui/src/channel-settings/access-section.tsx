// Access section: read-only pointer to workspace grants. Per-channel grants
// (mock's grant table) are a later ticket — this stays the same body copy
// the dialog shipped.

import { CHAT_STRINGS } from "../strings";

export function AccessSection() {
  return (
    <div className="channel-settings-pane">
      <p className="chat-settings-field-hint">
        {CHAT_STRINGS.channelSettingsAccessBody}
      </p>
    </div>
  );
}
