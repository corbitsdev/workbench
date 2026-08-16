// Notifications section: personal-only preference, persisted through
// @corbits/preferences (per-principal, per-workbench) keyed by this
// channel. Saves immediately on choice, the same instant-apply shape as
// CapacitySection's switch.

import { toast } from "@corbits/react-ui";
import { useEffect, useState } from "react";

import { CHAT_STRINGS } from "../strings";
import {
  getNotificationPreference,
  setNotificationPreference,
} from "./notifications-api";

const NOTIFICATION_CHOICES = [
  ["all", CHAT_STRINGS.channelSettingsNotifyAll],
  ["mentions", CHAT_STRINGS.channelSettingsNotifyMentions],
  ["mute", CHAT_STRINGS.channelSettingsNotifyMute],
] as const;

export type NotificationPreference = (typeof NOTIFICATION_CHOICES)[number][0];

export function NotificationsSection({
  tenantId,
  channelId,
}: {
  readonly tenantId: string;
  readonly channelId: string;
}) {
  const [value, setValue] = useState<NotificationPreference>("all");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getNotificationPreference(tenantId, channelId).then((preference) => {
      if (cancelled) return;
      setValue(preference);
    });
    return () => {
      cancelled = true;
    };
  }, [tenantId, channelId]);

  function handleChange(next: NotificationPreference) {
    const previous = value;
    setValue(next);
    setSaving(true);
    setError(null);
    setNotificationPreference(tenantId, channelId, next)
      .then((saved) => {
        setValue(saved);
        toast(CHAT_STRINGS.channelSettingsSavedToast);
      })
      .catch(() => {
        setValue(previous);
        setError(CHAT_STRINGS.channelSettingsNotificationsSaveError);
      })
      .finally(() => setSaving(false));
  }

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
            disabled={saving}
            onClick={() => handleChange(id)}
          >
            <span className="chat-kind-card-title">{label}</span>
          </button>
        ))}
      </div>
      <p className="chat-settings-field-hint">
        {CHAT_STRINGS.channelSettingsNotificationsHint}
      </p>
      {error !== null ? (
        <p className="chat-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
