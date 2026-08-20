// Personal "Your agent" settings: autonomy, morning brief, standing
// instructions, pinned skills, and inference dials. No hub preference store
// exists yet for these fields — the form is interactive for layout parity and
// holds draft state only; save is honest about that.
//
// REMOVED FROM THE SETTINGS REGISTRY (see section-registry.tsx): six fields
// that save nothing are fake controls, not a settings section — honest
// absence beats that. Re-add the "agent" section to
// `SETTINGS_SECTION_GROUPS`'s "personal" group only once a hub preference
// store exists for these fields and `handleSave` actually persists them,
// not before.

import { Button, Input, SettingsPanel } from "@corbits/react-ui";
import { useState } from "react";

import { SETTINGS_STRINGS } from "./strings";

const AUTONOMY_OPTIONS = [
  { value: "prepare", label: SETTINGS_STRINGS.agentAutonomyPrepare },
  { value: "gated", label: SETTINGS_STRINGS.agentAutonomyGated },
  { value: "autonomous", label: SETTINGS_STRINGS.agentAutonomyAutonomous },
] as const;

const BRIEF_OPTIONS = [
  { value: "off", label: SETTINGS_STRINGS.agentBriefOff },
  { value: "07:30", label: SETTINGS_STRINGS.agentBrief0730 },
  { value: "09:00", label: SETTINGS_STRINGS.agentBrief0900 },
] as const;

const DEFAULT_PINNED = ["Web research", "Long-form write", "Spreadsheet ops"];

export function AgentSection() {
  const [autonomy, setAutonomy] = useState<string>("gated");
  const [brief, setBrief] = useState<string>("07:30");
  const [instructions, setInstructions] = useState<string>(
    SETTINGS_STRINGS.agentInstructionsDefault,
  );
  const [pinned, setPinned] = useState<readonly string[]>(DEFAULT_PINNED);
  const [creativity, setCreativity] = useState(35);
  const [thinking, setThinking] = useState(60);
  const [note, setNote] = useState<string | null>(null);

  function handleSave() {
    setNote(SETTINGS_STRINGS.agentSaveHonesty);
  }

  function removePin(skill: string) {
    setPinned((prev) => prev.filter((s) => s !== skill));
  }

  return (
    <SettingsPanel
      title={SETTINGS_STRINGS.agentSectionTitle}
      description={SETTINGS_STRINGS.agentSectionDescription}
    >
      <h3 className="settings-subhead">
        {SETTINGS_STRINGS.agentAutonomyHeading}
      </h3>
      <label className="settings-form-field">
        <span>{SETTINGS_STRINGS.agentAutonomyLabel}</span>
        <select
          className="settings-select"
          value={autonomy}
          onChange={(event) => setAutonomy(event.target.value)}
        >
          {AUTONOMY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="settings-form-field">
        <span>{SETTINGS_STRINGS.agentBriefLabel}</span>
        <select
          className="settings-select"
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
        >
          {BRIEF_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <h3 className="settings-subhead">
        {SETTINGS_STRINGS.agentInstructionsHeading}
      </h3>
      <label className="settings-form-field">
        <span>{SETTINGS_STRINGS.agentInstructionsLabel}</span>
        <textarea
          className="settings-textarea"
          rows={3}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>

      <h3 className="settings-subhead">
        {SETTINGS_STRINGS.agentPinnedHeading}
      </h3>
      <div className="settings-chip-row">
        {pinned.map((skill) => (
          <span key={skill} className="settings-chip">
            {skill}
            <button
              type="button"
              className="settings-chip-remove"
              aria-label={`Unpin ${skill}`}
              onClick={() => removePin(skill)}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <p className="settings-field-hint">{SETTINGS_STRINGS.agentPinnedHint}</p>

      <h3 className="settings-subhead">
        {SETTINGS_STRINGS.agentInferenceHeading}
      </h3>
      <label className="settings-form-field">
        <span>
          {SETTINGS_STRINGS.agentCreativityLabel} ({creativity})
        </span>
        <Input
          type="range"
          min={0}
          max={100}
          value={creativity}
          onChange={(event) => setCreativity(Number(event.target.value))}
        />
      </label>
      <label className="settings-form-field">
        <span>
          {SETTINGS_STRINGS.agentThinkingLabel} ({thinking})
        </span>
        <Input
          type="range"
          min={0}
          max={100}
          value={thinking}
          onChange={(event) => setThinking(Number(event.target.value))}
        />
      </label>

      <div className="settings-section-toolbar">
        <Button variant="primary" onClick={handleSave}>
          {SETTINGS_STRINGS.agentSaveAction}
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
