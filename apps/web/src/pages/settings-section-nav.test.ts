/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  MORNING_BRIEF_ANCHOR_ID,
  SETTINGS_SECTIONS,
  resolveActiveSectionId,
} from "./settings-section-nav";

describe("resolveActiveSectionId", () => {
  it("resolves a matching top-level section hash", () => {
    expect(resolveActiveSectionId("#your-agent")).toBe("your-agent");
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
