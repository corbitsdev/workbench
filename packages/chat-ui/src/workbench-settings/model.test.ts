import { describe, expect, test } from "bun:test";

import {
  capacitySectionVisible,
  isWorkbenchSettingsSectionId,
  workbenchSettingsSections,
  WORKBENCH_SETTINGS_SECTION_IDS,
} from "./model";

describe("isWorkbenchSettingsSectionId", () => {
  test("is true for exactly the known section ids", () => {
    for (const id of WORKBENCH_SETTINGS_SECTION_IDS) {
      expect(isWorkbenchSettingsSectionId(id)).toBe(true);
    }
  });

  test("is false for a value that isn't a section id", () => {
    expect(isWorkbenchSettingsSectionId("not-a-real-section")).toBe(false);
    expect(isWorkbenchSettingsSectionId("")).toBe(false);
  });
});

describe("capacitySectionVisible", () => {
  test("hides Capacity only when the probe confirmed unavailable", () => {
    expect(capacitySectionVisible("unavailable")).toBe(false);
  });

  test("shows Capacity when the provisioner is available", () => {
    expect(capacitySectionVisible("available")).toBe(true);
  });

  test("shows Capacity when the probe failed — unknown is not unavailable", () => {
    expect(capacitySectionVisible("unknown")).toBe(true);
  });
});

describe("workbenchSettingsSections", () => {
  test("workbenches expose the full settings surface: General/Agents in Shared, Notifications in Personal", () => {
    expect(workbenchSettingsSections("workbench").map((s) => s.id)).toEqual([
      "general",
      "members",
      "agents",
      "notifications",
      "danger",
    ]);
  });

  test("1:1 chats trim Members and Danger zone", () => {
    expect(workbenchSettingsSections("chat").map((s) => s.id)).toEqual([
      "general",
      "agents",
      "notifications",
    ]);
  });

  test("a DM chat additionally trims Agents — no agent participant, nothing to invite", () => {
    expect(workbenchSettingsSections("chat", true).map((s) => s.id)).toEqual([
      "general",
      "notifications",
    ]);
  });

  test("an agent chat keeps Agents when isDm is explicitly false", () => {
    expect(workbenchSettingsSections("chat", false).map((s) => s.id)).toEqual([
      "general",
      "agents",
      "notifications",
    ]);
  });

  test("isDm is ignored for a workbench — Agents stays regardless", () => {
    expect(
      workbenchSettingsSections("workbench", true).map((s) => s.id),
    ).toEqual(["general", "members", "agents", "notifications", "danger"]);
  });

  test("Myra/Keys & plugins/Inference are gone as distinct nav ids", () => {
    const ids = workbenchSettingsSections("workbench").map((s) => s.id);
    expect(ids).not.toContain("assistant");
    expect(ids).not.toContain("keys-plugins");
    expect(ids).not.toContain("inference");
  });

  test("Plugins is global-only now — no workbench-scoped nav id", () => {
    expect(
      workbenchSettingsSections("workbench").map((s) => s.id),
    ).not.toContain("plugins");
    expect(
      workbenchSettingsSections("chat", true).map((s) => s.id),
    ).not.toContain("plugins");
  });

  test("Capacity is absent by default — this server has no isolated capacity to offer", () => {
    expect(workbenchSettingsSections("chat").map((s) => s.id)).not.toContain(
      "capacity",
    );
    expect(
      workbenchSettingsSections("workbench").map((s) => s.id),
    ).not.toContain("capacity");
  });

  test("Capacity appears, after Notifications, when this server offers it", () => {
    expect(
      workbenchSettingsSections("workbench", false, "available").map(
        (s) => s.id,
      ),
    ).toEqual([
      "general",
      "members",
      "agents",
      "notifications",
      "capacity",
      "danger",
    ]);
  });

  test("Capacity appears when the probe is unknown — a failed probe is not unavailable", () => {
    expect(
      workbenchSettingsSections("workbench", false, "unknown").map((s) => s.id),
    ).toContain("capacity");
  });

  test("Capacity stays hidden when the probe confirmed unavailable", () => {
    expect(
      workbenchSettingsSections("workbench", false, "unavailable").map(
        (s) => s.id,
      ),
    ).not.toContain("capacity");
  });

  test("groups sections Shared / Personal / Danger for the nav", () => {
    const groups = workbenchSettingsSections("workbench").map((s) => s.group);
    expect(groups).toEqual([
      "shared",
      "shared",
      "shared",
      "personal",
      "danger",
    ]);
  });

  test("Capacity is grouped Shared even though it sits after Notifications in the list", () => {
    const withCapacity = workbenchSettingsSections(
      "workbench",
      false,
      "available",
    );
    const capacity = withCapacity.find((s) => s.id === "capacity");
    expect(capacity?.group).toBe("shared");
  });
});
