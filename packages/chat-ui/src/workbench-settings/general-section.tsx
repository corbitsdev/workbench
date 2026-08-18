// General section: identity (name, purpose) and behavior (pinned, context
// window).

import { Input, Switch } from "@corbits/react-ui";

import { CHAT_STRINGS } from "../strings";
import type { ContextWindowMode } from "./context-window";

export function GeneralSection({
  workbenchId,
  name,
  onNameChange,
  purpose,
  onPurposeChange,
  pinned,
  onPinnedChange,
  contextWindowMode,
  onContextWindowModeChange,
  contextWindowInput,
  onContextWindowInputChange,
  benchDefault,
}: {
  readonly workbenchId: string;
  readonly name: string;
  readonly onNameChange: (value: string) => void;
  readonly purpose: string;
  readonly onPurposeChange: (value: string) => void;
  readonly pinned: boolean;
  readonly onPinnedChange: (value: boolean) => void;
  readonly contextWindowMode: ContextWindowMode;
  readonly onContextWindowModeChange: (mode: ContextWindowMode) => void;
  readonly contextWindowInput: string;
  readonly onContextWindowInputChange: (value: string) => void;
  readonly benchDefault: number;
}) {
  return (
    <div className="workbench-settings-pane">
      <label className="chat-settings-field">
        <span>{CHAT_STRINGS.workbenchSettingsNameLabel}</span>
        <Input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </label>
      <label className="chat-settings-field">
        <span>{CHAT_STRINGS.workbenchSettingsPurposeLabel}</span>
        <textarea
          className="chat-textarea"
          value={purpose}
          onChange={(event) => onPurposeChange(event.target.value)}
          placeholder={CHAT_STRINGS.workbenchSettingsPurposePlaceholder}
          rows={2}
        />
      </label>
      <label className="chat-settings-field chat-settings-field-inline">
        <span>{CHAT_STRINGS.workbenchSettingsPinnedLabel}</span>
        <Switch
          checked={pinned}
          onCheckedChange={onPinnedChange}
          label={CHAT_STRINGS.workbenchSettingsPinnedLabel}
        />
      </label>
      <p className="chat-settings-field-hint">
        {CHAT_STRINGS.workbenchSettingsPinnedDescription}
      </p>
      <div className="chat-settings-field">
        <span>{CHAT_STRINGS.workbenchSettingsContextWindowLabel}</span>
        <div
          className="chat-context-window-control"
          role="radiogroup"
          aria-label={CHAT_STRINGS.workbenchSettingsContextWindowLabel}
        >
          <label className="chat-context-window-option">
            <input
              type="radio"
              name={`context-window-mode-${workbenchId}`}
              checked={contextWindowMode === "inherit"}
              onChange={() => onContextWindowModeChange("inherit")}
            />
            {CHAT_STRINGS.workbenchSettingsUseBenchDefault(benchDefault)}
          </label>
          <label className="chat-context-window-option">
            <input
              type="radio"
              name={`context-window-mode-${workbenchId}`}
              checked={contextWindowMode === "override"}
              onChange={() => onContextWindowModeChange("override")}
            />
            {CHAT_STRINGS.workbenchSettingsUseOverride}
          </label>
          <Input
            value={contextWindowInput}
            disabled={contextWindowMode === "inherit"}
            inputMode="numeric"
            onChange={(event) => onContextWindowInputChange(event.target.value)}
          />
        </div>
      </div>
      <p className="chat-settings-field-hint">
        {CHAT_STRINGS.workbenchSettingsContextWindowDescription}
      </p>
      <div className="chat-settings-callout">
        <span className="chat-settings-callout-label">
          {CHAT_STRINGS.workbenchSettingsDeliveryTitle}
        </span>
        <p>{CHAT_STRINGS.workbenchSettingsDeliveryBody}</p>
      </div>
    </div>
  );
}
