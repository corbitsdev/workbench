import { describe, expect, it, mock } from "bun:test";
import {
  MAX_PINNED_MYRA_SKILLS,
  renderPinnedSkillsSection,
} from "@workbench/myra";

const listSkillsMock = mock(async () => [
  {
    id: "skill-a",
    name: "alpha",
    displayName: "Alpha skill",
    description: "First line\nBody must not appear",
    createdAt: "",
    updatedAt: "",
    scope: "tenant" as const,
    accessTenantId: "tn",
    ownerUserId: null,
    ownerName: null,
  },
  {
    id: "skill-b",
    name: "beta",
    displayName: null,
    description: "Beta one-liner",
    createdAt: "",
    updatedAt: "",
    scope: "private" as const,
    accessTenantId: "tn",
    ownerUserId: "u1",
    ownerName: null,
  },
  {
    id: "skill-c",
    name: "landing-page",
    displayName: "landing-page",
    description: "Landing page copy",
    createdAt: "",
    updatedAt: "",
    scope: "tenant" as const,
    accessTenantId: "tn",
    ownerUserId: null,
    ownerName: null,
  },
]);

mock.module("../services/skill-library", () => ({
  listSkills: listSkillsMock,
}));

const { resolvePinnedSkillIndexEntries } = await import("./myra-pinned-skills");

describe("resolvePinnedSkillIndexEntries", () => {
  it("skips dangling ids and never includes skill bodies", async () => {
    const { entries } = await resolvePinnedSkillIndexEntries(
      {} as never,
      { tenantId: "tn", userId: "u1" },
      ["missing", "skill-a", "skill-b"],
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]?.name).toBe("Alpha skill");
    expect(entries[0]?.description).toBe("First line");
    expect(entries[0]?.description).not.toContain("Body must not appear");
  });

  it("humanizes a slug-shaped displayName instead of feeding the raw slug into the prompt", async () => {
    const { entries } = await resolvePinnedSkillIndexEntries(
      {} as never,
      { tenantId: "tn", userId: "u1" },
      ["skill-c"],
    );
    expect(entries[0]?.name).toBe("Landing page");
    expect(entries[0]?.name).not.toBe("landing-page");

    const section = renderPinnedSkillsSection(entries, { xml: true });
    expect(section).toContain("Landing page");
    expect(section).not.toContain("landing-page");
  });

  it("enforces the max bound when resolving", async () => {
    const manyIds = Array.from({ length: 12 }, (_, i) => `skill-${i}`);
    listSkillsMock.mockImplementationOnce(async () =>
      manyIds.map((id) => ({
        id,
        name: id,
        displayName: null,
        description: "d",
        createdAt: "",
        updatedAt: "",
        scope: "tenant" as const,
        accessTenantId: "tn",
        ownerUserId: null,
        ownerName: null,
      })),
    );
    const { entries } = await resolvePinnedSkillIndexEntries(
      {} as never,
      { tenantId: "tn", userId: "u1" },
      manyIds,
    );
    expect(entries.length).toBe(MAX_PINNED_MYRA_SKILLS);
  });
});

describe("renderPinnedSkillsSection", () => {
  it("renders nothing when entries are empty", () => {
    expect(renderPinnedSkillsSection([], { xml: true })).toBeNull();
  });
});
