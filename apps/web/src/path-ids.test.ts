import { describe, expect, test } from "bun:test";

import {
  AGENTS_PATH_PREFIX,
  agentIdFromPath,
  detailSlugFromPath,
  settingsEntityIdFromPath,
  settingsSectionIdFromPath,
} from "./path-ids";

describe("detailSlugFromPath", () => {
  test("reads the slug a detail path carries", () => {
    expect<string | null>(
      detailSlugFromPath("/agents/triage-bot", AGENTS_PATH_PREFIX),
    ).toBe("triage-bot");
  });

  test("rejects the bare prefix, another prefix, and a nested path", () => {
    expect(detailSlugFromPath("/agents", AGENTS_PATH_PREFIX)).toBeNull();
    expect(detailSlugFromPath("/agents/", AGENTS_PATH_PREFIX)).toBeNull();
    expect(
      detailSlugFromPath("/skills/triage-bot", AGENTS_PATH_PREFIX),
    ).toBeNull();
    expect(
      detailSlugFromPath("/agents/triage-bot/runs", AGENTS_PATH_PREFIX),
    ).toBeNull();
  });

  test("rejects an id-shaped segment so id deep links stay with the roster", () => {
    expect(detailSlugFromPath("/agents/wfd_1", AGENTS_PATH_PREFIX)).toBeNull();
  });

  test("rejects percent-escapes rather than decoding them", () => {
    expect(detailSlugFromPath("/agents/%", AGENTS_PATH_PREFIX)).toBeNull();
    expect(
      detailSlugFromPath("/agents/%E0%A4%A", AGENTS_PATH_PREFIX),
    ).toBeNull();
    expect(
      detailSlugFromPath("/agents/triage%2Dbot", AGENTS_PATH_PREFIX),
    ).toBeNull();
  });
});

describe("id extraction", () => {
  test("decodes an escaped id", () => {
    expect(agentIdFromPath("/agents/wfd%201")).toBe("wfd 1");
  });

  test("a malformed escape names no entity instead of throwing", () => {
    expect(agentIdFromPath("/agents/%")).toBeNull();
    expect(settingsSectionIdFromPath("/settings/%E0%A4%A")).toBeNull();
    expect(settingsEntityIdFromPath("/settings/agents/%", "agents")).toBeNull();
  });
});
