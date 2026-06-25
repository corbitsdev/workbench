/// <reference types="bun" />
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { SettingsSection } from "./SettingsSection";
import { type SettingsSectionDescriptor } from "./types";

const section: SettingsSectionDescriptor = {
  id: "profile",
  title: "Profile",
  fields: [
    {
      key: "displayName",
      label: "Display name",
      kind: "text",
      description: "Shown publicly",
    },
    {
      key: "emailNotifications",
      label: "Email notifications",
      kind: "toggle",
      disabled: true,
    },
    {
      key: "theme",
      label: "Theme",
      kind: "select",
      options: [
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
      ],
    },
  ],
};

describe("SettingsSection", () => {
  it("renders field descriptions when present", () => {
    render(
      React.createElement(SettingsSection, {
        section,
        values: {
          displayName: "Jane",
          emailNotifications: false,
          theme: "light",
        },
        onChange: () => {},
      }),
    );
    expect(screen.getByText("Shown publicly")).toBeDefined();
  });

  it("omits the section description element when not provided", () => {
    render(
      React.createElement(SettingsSection, {
        section,
        values: {},
        onChange: () => {},
      }),
    );
    expect(screen.queryByText(/account details/i)).toBeNull();
  });

  it("renders the section description when provided", () => {
    render(
      React.createElement(SettingsSection, {
        section: { ...section, description: "Your account details" },
        values: {},
        onChange: () => {},
      }),
    );
    expect(screen.getByText("Your account details")).toBeDefined();
  });

  it("disables a control when the field is marked disabled", () => {
    render(
      React.createElement(SettingsSection, {
        section,
        values: { emailNotifications: true },
        onChange: () => {},
      }),
    );
    const toggle = screen.getByRole("switch", {
      name: "Email notifications",
    }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
  });

  it("coerces a non-string text value to an empty string", () => {
    render(
      React.createElement(SettingsSection, {
        section,
        // a boolean value for a text field exercises the typeof guard
        values: { displayName: true },
        onChange: () => {},
      }),
    );
    const input = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("treats a missing toggle value as unchecked", () => {
    render(
      React.createElement(SettingsSection, {
        section,
        values: {},
        onChange: () => {},
      }),
    );
    const toggle = screen.getByRole("switch", { name: "Email notifications" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("passes the changed select value through onChange", () => {
    const onChange = mock((_key: string, _value: string | boolean) => {});
    render(
      React.createElement(SettingsSection, {
        section: { ...section, fields: [section.fields[2]!] },
        values: { theme: "light" },
        onChange,
      }),
    );
    fireEvent.change(screen.getByLabelText("Theme"), {
      target: { value: "dark" },
    });
    expect(onChange.mock.calls[0]).toEqual(["theme", "dark"]);
  });
});
