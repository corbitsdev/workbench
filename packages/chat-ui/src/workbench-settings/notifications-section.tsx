// Notifications section: personal-only preference, persisted through
// @corbits/preferences (per-principal, per-workbench) keyed by this
// workbench. Saves immediately on choice, the same instant-apply shape as
// CapacitySection's switch.

import { toast } from "@corbits/react-ui";
import { useEffect, useState } from "react";

import { CHAT_STRINGS } from "../strings";
import {
  getNotificationPreference,
  setNotificationPreference,
} from "./notifications-api";

const NOTIFICATION_CHOICES = [
  ["all", CHAT_STRINGS.workbenchSettingsNotifyAll],
  ["mentions", CHAT_STRINGS.workbenchSettingsNotifyMentions],
  ["mute", CHAT_STRINGS.workbenchSettingsNotifyMute],
] as const;

export type NotificationPreference = (typeof NOTIFICATION_CHOICES)[number][0];

export function NotificationsSection({
  tenantId,
  workbenchId,
}: {
  readonly tenantId: string;
  readonly workbenchId: string;
}) {
  const [value, setValue] = useState<NotificationPreference>("all");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getNotificationPreference(tenantId, workbenchId).then((preference) => {
      if (cancelled) return;
      setValue(preference);
    });
    return () => {
      cancelled = true;
    };
  }, [tenantId, workbenchId]);

  function handleChange(next: NotificationPreference) {
    const previous = value;
    setValue(next);
    setSaving(true);
    setError(null);
    setNotificationPreference(tenantId, workbenchId, next)
      .then((saved) => {
        setValue(saved);
        toast(CHAT_STRINGS.workbenchSettingsSavedToast);
      })
      .catch(() => {
        setValue(previous);
        setError(CHAT_STRINGS.workbenchSettingsNotificationsSaveError);
      })
      .finally(() => setSaving(false));
  }

  return (
    <div className="workbench-settings-pane">
      <div
        role="radiogroup"
        aria-label={CHAT_STRINGS.workbenchSettingsNotificationsLabel}
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
        {CHAT_STRINGS.workbenchSettingsNotificationsHint}
      </p>
      {error !== null ? (
        <p className="chat-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
