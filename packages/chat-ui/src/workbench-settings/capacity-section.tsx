// The workbench "Capacity" section (CL-6117, rehomed from CL-6096's
// unregistered bench section): whether this workbench's agents run on
// their own dedicated capacity, or share it with other workbenches. Saves
// immediately on toggle — a Switch, not a form field — with an optimistic
// flip that reverts on failure, the same instant-apply shape as any other
// switch on this surface.

import { Switch, toast } from "@corbits/react-ui";
import { useEffect, useState } from "react";

import { CHAT_STRINGS } from "../strings";
import { getCapacityPlacement, setCapacityPlacement } from "./capacity-api";

export function CapacitySection({ tenantId }: { readonly tenantId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [available, setAvailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCapacityPlacement(tenantId).then((result) => {
      if (cancelled) return;
      setEnabled(result.enabled);
      setAvailable(result.provisionerAvailable);
    });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  function handleChange(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    setError(null);
    setCapacityPlacement(tenantId, next)
      .then((result) => {
        setEnabled(result.enabled);
        setAvailable(result.provisionerAvailable);
        toast(CHAT_STRINGS.workbenchSettingsSavedToast);
      })
      .catch(() => {
        setEnabled(previous);
        setError(CHAT_STRINGS.workbenchSettingsCapacitySaveError(next));
      })
      .finally(() => setSaving(false));
  }

  return (
    <div className="workbench-settings-pane">
      <p className="chat-settings-field-hint">
        {CHAT_STRINGS.workbenchSettingsCapacityDescription}
      </p>
      <div className="chat-settings-field chat-settings-field-inline">
        <label htmlFor="capacity-switch">
          {CHAT_STRINGS.workbenchSettingsCapacityLabel}
        </label>
        <Switch
          id="capacity-switch"
          checked={enabled}
          onCheckedChange={handleChange}
          disabled={saving || !available}
          describedBy="capacity-hint"
        />
      </div>
      <p id="capacity-hint" className="chat-settings-field-hint">
        {available
          ? CHAT_STRINGS.workbenchSettingsCapacityHint
          : CHAT_STRINGS.workbenchSettingsCapacityUnavailableHint}
      </p>
      {error !== null ? (
        <p className="chat-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
