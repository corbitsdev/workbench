/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  SettingsField,
  SettingsSelectField,
  SettingsSectionDescriptor,
  SettingsTextField,
  SettingsToggleField,
} from "./types";

describe("SettingsTextField schema", () => {
  it("accepts a valid text field", () => {
    expect(() =>
      SettingsTextField.assert({
        key: "name",
        label: "Name",
        kind: "text",
      }),
    ).not.toThrow();
  });

  it("rejects missing kind", () => {
    expect(() =>
      SettingsTextField.assert({ key: "name", label: "Name" }),
    ).toThrow();
  });

  it("rejects wrong kind", () => {
    expect(() =>
      SettingsTextField.assert({ key: "name", label: "Name", kind: "toggle" }),
    ).toThrow();
  });
});

describe("SettingsToggleField schema", () => {
  it("accepts a valid toggle field", () => {
    expect(() =>
      SettingsToggleField.assert({ key: "flag", label: "Flag", kind: "toggle" }),
    ).not.toThrow();
  });

  it("rejects wrong kind", () => {
    expect(() =>
      SettingsToggleField.assert({ key: "flag", label: "Flag", kind: "text" }),
    ).toThrow();
  });
});

describe("SettingsSelectField schema", () => {
  it("accepts a valid select field with options", () => {
    expect(() =>
      SettingsSelectField.assert({
        key: "theme",
        label: "Theme",
        kind: "select",
        options: [{ value: "light", label: "Light" }],
      }),
    ).not.toThrow();
  });

  it("rejects missing options", () => {
    expect(() =>
      SettingsSelectField.assert({ key: "theme", label: "Theme", kind: "select" }),
    ).toThrow();
  });
});

describe("SettingsField discriminated union", () => {
  it("accepts a text field", () => {
    expect(() =>
      SettingsField.assert({ key: "x", label: "X", kind: "text" }),
    ).not.toThrow();
  });

  it("accepts a toggle field", () => {
    expect(() =>
      SettingsField.assert({ key: "x", label: "X", kind: "toggle" }),
    ).not.toThrow();
  });

  it("accepts a select field", () => {
    expect(() =>
      SettingsField.assert({
        key: "x",
        label: "X",
        kind: "select",
        options: [{ value: "a", label: "A" }],
      }),
    ).not.toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      SettingsField.assert({ key: "x", label: "X", kind: "radio" }),
    ).toThrow();
  });

  it("rejects a select field missing options", () => {
    expect(() =>
      SettingsField.assert({ key: "x", label: "X", kind: "select" }),
    ).toThrow();
  });

  it("rejects a non-object", () => {
    expect(() => SettingsField.assert("not an object")).toThrow();
  });
});

describe("SettingsSectionDescriptor schema", () => {
  it("accepts a valid section with mixed fields", () => {
    expect(() =>
      SettingsSectionDescriptor.assert({
        id: "general",
        title: "General",
        fields: [
          { key: "name", label: "Name", kind: "text" },
          { key: "flag", label: "Flag", kind: "toggle" },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects a section with an invalid field", () => {
    expect(() =>
      SettingsSectionDescriptor.assert({
        id: "general",
        title: "General",
        fields: [{ key: "x", label: "X", kind: "unknown" }],
      }),
    ).toThrow();
  });

  it("rejects missing title", () => {
    expect(() =>
      SettingsSectionDescriptor.assert({ id: "general", fields: [] }),
    ).toThrow();
  });
});
