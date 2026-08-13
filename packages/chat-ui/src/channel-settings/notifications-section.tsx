// Notifications section: personal-only preference — local draft UI until
// per-channel notification storage ships.

import { CHAT_STRINGS } from "../strings";

const NOTIFICATION_CHOICES = [
  ["all", CHAT_STRINGS.channelSettingsNotifyAll],
  ["mentions", CHAT_STRINGS.channelSettingsNotifyMentions],
  ["mute", CHAT_STRINGS.channelSettingsNotifyMute],
] as const;

export type NotificationPreference = (typeof NOTIFICATION_CHOICES)[number][0];

export function NotificationsSection({
  value,
  onChange,
}: {
  readonly value: NotificationPreference;
  readonly onChange: (value: NotificationPreference) => void;
}) {
  return (
    <div className="channel-settings-pane">
      <div
        role="radiogroup"
        aria-label={CHAT_STRINGS.channelSettingsNotificationsLabel}
        className="chat-settings-choice-row"
      >
        {NOTIFICATION_CHOICES.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="chat-kind-card"
            aria-pressed={value === id}
            onClick={() => onChange(id)}
          >
            <span className="chat-kind-card-title">{label}</span>
          </button>
        ))}
      </div>
      <p className="chat-settings-field-hint">
        {CHAT_STRINGS.channelSettingsNotificationsHint}
      </p>
    </div>
  );
}
