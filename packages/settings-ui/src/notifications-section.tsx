// Personal notification prefs. Delivery still routes through the product
// inbox / notify stack; these toggles are the operator-facing surface for
// which classes of activity should surface. No per-user preference store
// is mounted yet — draft state only, with an honesty note on save.
//
// REMOVED FROM THE SETTINGS REGISTRY (see section-registry.tsx; CL-6843):
// toggles that save nothing are fake controls, not a settings section —
// honest absence beats that. Re-add the "chat" section to
// `SETTINGS_SECTION_GROUPS`'s "account" group only once a per-user
// preference store exists for these fields and Save actually persists
// them, not before. (Workbench-scoped mute/mentions prefs live on
// `@corbits/chat-ui`'s workbench settings surface and already persist —
// that is a different surface.)

import { Button, SettingsPanel } from "@corbits/react-ui";
import { Check } from "@corbits/icons";
import { useState } from "react";

import { SETTINGS_STRINGS } from "./strings";

type PrefKey = "mentions" | "approvals" | "routineFail";

export function NotificationsSection() {
  const [prefs, setPrefs] = useState<Record<PrefKey, boolean>>({
    mentions: true,
    approvals: true,
    routineFail: true,
  });
  const [note, setNote] = useState<string | null>(null);

  function toggle(key: PrefKey) {
    setPrefs((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <SettingsPanel
      title={SETTINGS_STRINGS.notificationsSectionTitle}
      description={SETTINGS_STRINGS.notificationsSectionDescription}
    >
      <div className="settings-check-list">
        <button
          type="button"
          className="settings-check"
          aria-pressed={prefs.mentions}
          onClick={() => toggle("mentions")}
        >
          <span className="settings-check-box" aria-hidden="true">
            {prefs.mentions ? <Check /> : null}
          </span>
          <span>
            <strong>{SETTINGS_STRINGS.notificationsMentions}</strong>
          </span>
        </button>
        <button
          type="button"
          className="settings-check"
          aria-pressed={prefs.approvals}
          onClick={() => toggle("approvals")}
        >
          <span className="settings-check-box" aria-hidden="true">
            {prefs.approvals ? <Check /> : null}
          </span>
          <span>
            <strong>{SETTINGS_STRINGS.notificationsApprovals}</strong>
          </span>
        </button>
        <button
          type="button"
          className="settings-check"
          aria-pressed={prefs.routineFail}
          onClick={() => toggle("routineFail")}
        >
          <span className="settings-check-box" aria-hidden="true">
            {prefs.routineFail ? <Check /> : null}
          </span>
          <span>
            <strong>{SETTINGS_STRINGS.notificationsRoutineFail}</strong>
          </span>
        </button>
      </div>
      <div className="settings-section-toolbar">
        <Button
          variant="primary"
          onClick={() => setNote(SETTINGS_STRINGS.notificationsSaveHonesty)}
        >
          {SETTINGS_STRINGS.notificationsSaveAction}
        </Button>
      </div>
      {note !== null ? (
        <p className="settings-field-hint" role="status">
          {note}
        </p>
      ) : null}
    </SettingsPanel>
  );
}
