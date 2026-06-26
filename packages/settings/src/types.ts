/**
 * Settings view types.
 *
 * These describe the *shape* of a settings UI — sections, fields, and their
 * current values — without prescribing how values are loaded or persisted.
 * Persistence is the consumer's responsibility: it supplies `values` and an
 * `onChange` handler. The package itself is entirely stateless.
 */

import { type } from "arktype";

// ── Arktype schemas for boundary-crossing shapes ──────────────────────────────

export const SettingsSelectOption = type({
  value: "string",
  label: "string",
});
export type SettingsSelectOption = typeof SettingsSelectOption.infer;

export const SettingsTextField = type({
  key: "string",
  label: "string",
  "description?": "string",
  "disabled?": "boolean",
  kind: "'text'",
  "placeholder?": "string",
});
export type SettingsTextField = typeof SettingsTextField.infer;

export const SettingsToggleField = type({
  key: "string",
  label: "string",
  "description?": "string",
  "disabled?": "boolean",
  kind: "'toggle'",
});
export type SettingsToggleField = typeof SettingsToggleField.infer;

export const SettingsSelectField = type({
  key: "string",
  label: "string",
  "description?": "string",
  "disabled?": "boolean",
  kind: "'select'",
  options: SettingsSelectOption.array(),
});
export type SettingsSelectField = typeof SettingsSelectField.infer;

export const SettingsField = SettingsTextField.or(SettingsToggleField).or(
  SettingsSelectField,
);
export type SettingsField = typeof SettingsField.infer;

export const SettingsSectionDescriptor = type({
  id: "string",
  title: "string",
  "description?": "string",
  fields: SettingsField.array(),
});
export type SettingsSectionDescriptor =
  typeof SettingsSectionDescriptor.infer;

// ── Plain types — not JSON-expressible or internal/trusted ────────────────────

/** Discriminator for the kind of control a field renders. */
export type SettingsFieldKind = "text" | "toggle" | "select";

/** A primitive settings value. Each field kind maps to one of these. */
export type SettingsFieldValue = string | boolean;

/** Current value for every field, keyed by `SettingsField.key`. */
export type SettingsValues = Readonly<Record<string, SettingsFieldValue>>;

/** Fired when any field's value changes. */
export type SettingsChangeHandler = (
  key: string,
  value: SettingsFieldValue,
) => void;
