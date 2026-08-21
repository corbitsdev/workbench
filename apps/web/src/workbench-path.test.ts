import { describe, expect, test } from "bun:test";

import {
  workbenchIdFromPath,
  workbenchPath,
  workbenchSettingsPath,
  workbenchSettingsSectionFromPath,
  workbenchSettingsEntityIdFromPath,
  isWorkbenchPath,
  isWorkbenchSettingsPath,
} from "./workbench-path";

describe("workbenchPath helpers", () => {
  test("builds canonical /w paths", () => {
    expect(workbenchPath(null)).toBe("/w");
    expect(workbenchPath("ch_1")).toBe("/w/ch_1");
    expect(workbenchPath("ch/with/slash")).toBe("/w/ch%2Fwith%2Fslash");
  });

  test("parses /w and legacy /chat deep links", () => {
    expect(workbenchIdFromPath("/w")).toBeNull();
    expect(workbenchIdFromPath("/w/ch_1")).toBe("ch_1");
    expect(workbenchIdFromPath("/chat/ch_1")).toBe("ch_1");
    expect(workbenchIdFromPath("/routines")).toBeNull();
  });

  test("workbenchIdFromPath reads a malformed escape as no selection", () => {
    expect(workbenchIdFromPath("/w/%E0%A4%A")).toBeNull();
    expect(workbenchIdFromPath("/chat/%")).toBeNull();
  });

  test("isWorkbenchPath covers both prefixes", () => {
    expect(isWorkbenchPath("/w")).toBe(true);
    expect(isWorkbenchPath("/w/ch_1")).toBe(true);
    expect(isWorkbenchPath("/chat")).toBe(true);
    expect(isWorkbenchPath("/chat/ch_1")).toBe(true);
    expect(isWorkbenchPath("/")).toBe(false);
  });
});

describe("workbench settings path helpers", () => {
  test("builds the settings stage surface path", () => {
    expect(workbenchSettingsPath("ch_1")).toBe("/w/ch_1/settings");
  });

  test("builds a section-scoped settings path", () => {
    expect(workbenchSettingsPath("ch_1", "members")).toBe(
      "/w/ch_1/settings/members",
    );
  });

  test("builds a section entity deep link and encodes the entity id", () => {
    expect(workbenchSettingsPath("ch_1", "agents", "wfd_myra")).toBe(
      "/w/ch_1/settings/agents/wfd_myra",
    );
    expect(workbenchSettingsPath("ch_1", "agents", "a/b")).toBe(
      "/w/ch_1/settings/agents/a%2Fb",
    );
  });

  test("workbenchIdFromPath resolves ids under /settings", () => {
    expect(workbenchIdFromPath("/w/ch_1/settings")).toBe("ch_1");
    expect(workbenchIdFromPath("/chat/ch_1/settings")).toBe("ch_1");
  });

  test("workbenchIdFromPath resolves ids under a section-scoped /settings path", () => {
    expect(workbenchIdFromPath("/w/ch_1/settings/members")).toBe("ch_1");
    expect(workbenchIdFromPath("/chat/ch_1/settings/agents")).toBe("ch_1");
  });

  test("workbenchIdFromPath resolves ids under a section entity deep link", () => {
    expect(workbenchIdFromPath("/w/ch_1/settings/agents/wfd_myra")).toBe(
      "ch_1",
    );
    expect(workbenchIdFromPath("/chat/ch_1/settings/agents/wfd_myra")).toBe(
      "ch_1",
    );
  });

  test("isWorkbenchSettingsPath is true for /settings, /settings/:section, and entity", () => {
    expect(isWorkbenchSettingsPath("/w/ch_1/settings")).toBe(true);
    expect(isWorkbenchSettingsPath("/w/ch_1/settings/members")).toBe(true);
    expect(isWorkbenchSettingsPath("/w/ch_1/settings/agents/wfd_1")).toBe(true);
    expect(isWorkbenchSettingsPath("/w/ch_1")).toBe(false);
    expect(isWorkbenchSettingsPath("/w")).toBe(false);
  });

  test("workbenchSettingsSectionFromPath extracts the trailing section segment", () => {
    expect(workbenchSettingsSectionFromPath("/w/ch_1/settings/members")).toBe(
      "members",
    );
    expect(workbenchSettingsSectionFromPath("/chat/ch_1/settings/agents")).toBe(
      "agents",
    );
    expect(
      workbenchSettingsSectionFromPath("/w/ch_1/settings"),
    ).toBeUndefined();
    expect(workbenchSettingsSectionFromPath("/w/ch_1")).toBeUndefined();
  });

  test("workbenchSettingsSectionFromPath reads an unrecognized section id as no section", () => {
    expect(
      workbenchSettingsSectionFromPath("/w/ch_1/settings/not-a-real-section"),
    ).toBeUndefined();
  });

  test("workbenchSettingsSectionFromPath ignores a trailing entity id", () => {
    expect(
      workbenchSettingsSectionFromPath("/w/ch_1/settings/agents/wfd_myra"),
    ).toBe("agents");
    expect(
      workbenchSettingsSectionFromPath("/chat/ch_1/settings/agents/a%2Fb"),
    ).toBe("agents");
  });

  test("workbenchSettingsEntityIdFromPath extracts the entity under a section", () => {
    expect(
      workbenchSettingsEntityIdFromPath(
        "/w/ch_1/settings/agents/wfd_myra",
        "agents",
      ),
    ).toBe("wfd_myra");
    expect(
      workbenchSettingsEntityIdFromPath(
        "/chat/ch_1/settings/agents/a%2Fb",
        "agents",
      ),
    ).toBe("a/b");
    expect(
      workbenchSettingsEntityIdFromPath("/w/ch_1/settings/agents", "agents"),
    ).toBeNull();
    expect(
      workbenchSettingsEntityIdFromPath(
        "/w/ch_1/settings/agents/wfd_myra",
        "members",
      ),
    ).toBeNull();
    expect(
      workbenchSettingsEntityIdFromPath("/w/ch_1/settings", "agents"),
    ).toBeNull();
  });

  test("workbenchSettingsSectionFromPath reads a malformed escape as no section", () => {
    expect(
      workbenchSettingsSectionFromPath("/w/ch_1/settings/%E0%A4%A"),
    ).toBeUndefined();
  });

  test("workbenchSettingsEntityIdFromPath reads a malformed escape as no entity", () => {
    expect(
      workbenchSettingsEntityIdFromPath(
        "/w/ch_1/settings/agents/%E0%A4%A",
        "agents",
      ),
    ).toBeNull();
  });
});
