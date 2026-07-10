import { beforeEach, describe, expect, mock, test } from "bun:test";

// `getOwnedSkillDraftItem` authorizes a legacy (unstamped) row through
// `canActOnSkillDraft`, which resolves the agent's owning member. Mock that
// boundary so the owner-guard branch is reachable without a real member graph.
const resolveOwnerMemberPrincipalId = mock(
  async () => "prn_owner" as string | null,
);
mock.module("../lib/artifact-tools", () => ({
  resolveOwnerMemberPrincipalId,
}));

const { getOwnedSkillDraftItem } = await import("./skill-library");

const owner = { tenantId: "ten_1", principalId: "prn_owner" };

function dbReturning(rows: Record<string, unknown>[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => rows,
  };
  return { select: () => chain } as never;
}

function draftRow(over: Record<string, unknown> = {}) {
  return {
    id: "art_d1",
    kind: "skill-draft",
    tenantId: "ten_1",
    ownerPrincipalId: "prn_owner",
    principalId: "prn_agent",
    title: "Deck Builder",
    content: "# Deck Builder\nBuild a deck.",
    source: { description: "Turns notes into a deck", files: [] },
    status: "draft",
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  resolveOwnerMemberPrincipalId.mockClear();
  resolveOwnerMemberPrincipalId.mockImplementation(async () => "prn_owner");
});

describe("getOwnedSkillDraftItem", () => {
  test("shapes an owned pending draft into a SkillDraftItem", async () => {
    const item = await getOwnedSkillDraftItem(
      dbReturning([draftRow()]),
      owner,
      "art_d1",
    );
    expect(item).toMatchObject({
      id: "art_d1",
      title: "Deck Builder",
      content: "# Deck Builder\nBuild a deck.",
      description: "Turns notes into a deck",
      status: "draft",
    });
  });

  test("reports a missing draft as not-found, naming the id", async () => {
    await expect(
      getOwnedSkillDraftItem(dbReturning([]), owner, "art_missing"),
    ).rejects.toThrow("Skill draft not found: art_missing");
  });

  test("reports a stamped draft owned by someone else as not-found", async () => {
    await expect(
      getOwnedSkillDraftItem(
        dbReturning([draftRow({ ownerPrincipalId: "prn_someone_else" })]),
        owner,
        "art_d1",
      ),
    ).rejects.toThrow("Skill draft not found: art_d1");
  });

  test("reports an already-approved draft as not-found (pending-only contract)", async () => {
    await expect(
      getOwnedSkillDraftItem(
        dbReturning([draftRow({ status: "approved" })]),
        owner,
        "art_d1",
      ),
    ).rejects.toThrow("Skill draft not found: art_d1");
  });

  test("reports a legacy unstamped draft as not-found, matching list_skill_drafts", async () => {
    // ownerPrincipalId null → canActOnSkillDraft admits it via the owning-member
    // fallback, but list_skill_drafts (stamped-only) would never surface it, so
    // load must agree and treat it as not a pending draft.
    await expect(
      getOwnedSkillDraftItem(
        dbReturning([draftRow({ ownerPrincipalId: null })]),
        owner,
        "art_d1",
      ),
    ).rejects.toThrow("Skill draft not found: art_d1");
  });
});
