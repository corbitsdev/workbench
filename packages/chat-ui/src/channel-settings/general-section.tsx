// General section: identity (name, purpose) and behavior (pinned, context
// window). Purpose is draft-only UI until its store lands — see
// CHAT_STRINGS.channelSettingsPurposeHint.

import { Input, Switch } from "@corbits/react-ui";

import { CHAT_STRINGS } from "../strings";
import type { ContextWindowMode } from "./context-window";

export function GeneralSection({
  channelId,
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
  readonly channelId: string;
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
    <div className="channel-settings-pane">
      <label className="chat-settings-field">
        <span>{CHAT_STRINGS.channelSettingsNameLabel}</span>
        <Input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </label>
      <label className="chat-settings-field">
        <span>{CHAT_STRINGS.channelSettingsPurposeLabel}</span>
        <textarea
          className="chat-textarea"
          value={purpose}
          onChange={(event) => onPurposeChange(event.target.value)}
          placeholder={CHAT_STRINGS.channelSettingsPurposePlaceholder}
          rows={2}
        />
        <span className="chat-settings-field-hint">
          {CHAT_STRINGS.channelSettingsPurposeHint}
        </span>
      </label>
      <label className="chat-settings-field chat-settings-field-inline">
        <span>{CHAT_STRINGS.channelSettingsPinnedLabel}</span>
        <Switch
          checked={pinned}
          onCheckedChange={onPinnedChange}
          label={CHAT_STRINGS.channelSettingsPinnedLabel}
        />
      </label>
      <p className="chat-settings-field-hint">
        {CHAT_STRINGS.channelSettingsPinnedDescription}
      </p>
      <div className="chat-settings-field">
        <span>{CHAT_STRINGS.channelSettingsContextWindowLabel}</span>
        <div
          className="chat-context-window-control"
          role="radiogroup"
          aria-label={CHAT_STRINGS.channelSettingsContextWindowLabel}
        >
          <label className="chat-context-window-option">
            <input
              type="radio"
              name={`context-window-mode-${channelId}`}
              checked={contextWindowMode === "inherit"}
              onChange={() => onContextWindowModeChange("inherit")}
            />
            {CHAT_STRINGS.channelSettingsUseBenchDefault(benchDefault)}
          </label>
          <label className="chat-context-window-option">
            <input
              type="radio"
              name={`context-window-mode-${channelId}`}
              checked={contextWindowMode === "override"}
              onChange={() => onContextWindowModeChange("override")}
            />
            {CHAT_STRINGS.channelSettingsUseOverride}
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
        {CHAT_STRINGS.channelSettingsContextWindowDescription}
      </p>
      <div className="chat-settings-callout">
        <strong>{CHAT_STRINGS.channelSettingsDeliveryTitle}</strong>
        <p>{CHAT_STRINGS.channelSettingsDeliveryBody}</p>
      </div>
    </div>
  );
}
