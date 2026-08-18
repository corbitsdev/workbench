import { describe, expect, test } from "bun:test";

import {
  workbenchIdFromPath,
  workbenchPath,
  workbenchSettingsPath,
  workbenchSettingsSectionFromPath,
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

  test("workbenchIdFromPath resolves ids under /settings", () => {
    expect(workbenchIdFromPath("/w/ch_1/settings")).toBe("ch_1");
    expect(workbenchIdFromPath("/chat/ch_1/settings")).toBe("ch_1");
  });

  test("workbenchIdFromPath resolves ids under a section-scoped /settings path", () => {
    expect(workbenchIdFromPath("/w/ch_1/settings/members")).toBe("ch_1");
    expect(workbenchIdFromPath("/chat/ch_1/settings/agents")).toBe("ch_1");
  });

  test("isWorkbenchSettingsPath is true for /settings and /settings/:section", () => {
    expect(isWorkbenchSettingsPath("/w/ch_1/settings")).toBe(true);
    expect(isWorkbenchSettingsPath("/w/ch_1/settings/members")).toBe(true);
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
});
