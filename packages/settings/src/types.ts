/**
 * Settings view types.
 *
 * These describe the *shape* of a settings UI — sections, fields, and their
 * current values — without prescribing how values are loaded or persisted.
 * Persistence is the consumer's responsibility: it supplies `values` and an
 * `onChange` handler. The package itself is entirely stateless.
 */

/** Discriminator for the kind of control a field renders. */
export type SettingsFieldKind = "text" | "toggle" | "select";

/** A primitive settings value. Each field kind maps to one of these. */
export type SettingsFieldValue = string | boolean;

/** A selectable option for a `select` field. */
export interface SettingsSelectOption {
  readonly value: string;
  readonly label: string;
}

interface SettingsFieldBase {
  /** Stable key used to read/write the field's value in the values map. */
  readonly key: string;
  /** Human-readable label rendered next to the control. */
  readonly label: string;
  /** Optional helper text shown beneath the control. */
  readonly description?: string;
  /** When true, the control is rendered disabled. */
  readonly disabled?: boolean;
}

export interface SettingsTextField extends SettingsFieldBase {
  readonly kind: "text";
  readonly placeholder?: string;
}

export interface SettingsToggleField extends SettingsFieldBase {
  readonly kind: "toggle";
}

export interface SettingsSelectField extends SettingsFieldBase {
  readonly kind: "select";
  readonly options: readonly SettingsSelectOption[];
}

/** Any settings field descriptor. */
export type SettingsField =
  | SettingsTextField
  | SettingsToggleField
  | SettingsSelectField;

/** A logical grouping of related fields. */
export interface SettingsSectionDescriptor {
  /** Stable identifier for the section. */
  readonly id: string;
  /** Section heading. */
  readonly title: string;
  /** Optional supporting copy under the heading. */
  readonly description?: string;
  readonly fields: readonly SettingsField[];
}

/** Current value for every field, keyed by `SettingsField.key`. */
export type SettingsValues = Readonly<Record<string, SettingsFieldValue>>;

/** Fired when any field's value changes. */
export type SettingsChangeHandler = (
  key: string,
  value: SettingsFieldValue,
) => void;
