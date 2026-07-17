/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  MORNING_BRIEF_ANCHOR_ID,
  SETTINGS_MANAGEMENT_GROUPS,
  SETTINGS_SECTIONS,
  resolveActiveSectionId,
  visibleManagementGroups,
} from "./settings-section-nav";

describe("resolveActiveSectionId", () => {
  it("resolves a matching top-level section hash", () => {
    expect(resolveActiveSectionId("#your-agent")).toBe("your-agent");
  });

  it("resolves the Myra defaults section hash", () => {
    expect(resolveActiveSectionId("#myra-defaults")).toBe("myra-defaults");
  });

  it("resolves the personalization & style section hash", () => {
    expect(resolveActiveSectionId("#myra-style")).toBe("myra-style");
  });

  it("resolves the hash without a leading #", () => {
    expect(resolveActiveSectionId("account")).toBe("account");
  });

  it("maps the morning-brief anchor to its parent nav section", () => {
    expect(resolveActiveSectionId(`#${MORNING_BRIEF_ANCHOR_ID}`)).toBe(
      "inbox-capabilities",
    );
  });

  it("falls back to the first section for an empty hash", () => {
    expect(resolveActiveSectionId("")).toBe(SETTINGS_SECTIONS[0]?.id);
  });

  it("falls back to the first section for an unknown hash", () => {
    expect(resolveActiveSectionId("#not-a-real-section")).toBe(
      SETTINGS_SECTIONS[0]?.id,
    );
  });

  it("has a stable morning-brief anchor id for deep-linking from the inbox", () => {
    expect(MORNING_BRIEF_ANCHOR_ID).toBe("morning-brief");
  });
});

describe("visibleManagementGroups", () => {
  it("hides every management group for a plain member", () => {
    expect(visibleManagementGroups({ isAdmin: false, isOwner: false })).toEqual(
      [],
    );
  });

  it("shows only the admin group for an admin who is not an owner", () => {
    const groups = visibleManagementGroups({ isAdmin: true, isOwner: false });
    expect(groups.map((g) => g.id)).toEqual(["settings-admin"]);
  });

  it("shows only the owner group for an owner who is not an admin", () => {
    const groups = visibleManagementGroups({ isAdmin: false, isOwner: true });
    expect(groups.map((g) => g.id)).toEqual(["settings-owner"]);
  });

  it("shows both groups for a principal who is both admin and owner", () => {
    const groups = visibleManagementGroups({ isAdmin: true, isOwner: true });
    expect(groups).toEqual(SETTINGS_MANAGEMENT_GROUPS);
  });
});
