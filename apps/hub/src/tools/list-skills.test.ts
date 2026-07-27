import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createFakeDrizzleQuery } from "../testing/fake-drizzle";

type Skill = { id: string; name: string; displayName: string | null };

// Visibility is owned by skill-library; the handler must DELEGATE to it with
// the resolved stable user id. These canned maps stand in for the library's
// visibility decision so the handler's own contract (index-only shape, query
// filtering, body+siblings on load, fail-closed when the principal is unknown)
// is asserted in isolation. The real visibility seam is covered in the
// integration test, which exercises the un-mocked skill-library functions.
const visibleByUser = new Map<string, Skill[]>();
const assetByIdForUser = new Map<string, Skill | null>();
const filesByAsset = new Map<string, { path: string; content?: string }[]>();

const listSkills = mock(
  async (_db: unknown, viewer: { userId: string }) =>
    visibleByUser.get(viewer.userId) ?? [],
);
const getSkillAsset = mock(
  async (_db: unknown, viewer: { userId: string }, assetId: string) =>
    assetByIdForUser.get(`${viewer.userId}:${assetId}`) ?? null,
);
const getSkillContent = mock(
  async (_repoStore: unknown, assetId: string) =>
    filesByAsset.get(assetId) ?? [],
);

function toAssetName(displayName: string): string {
  return (
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "skill"
  );
}

function matchSkillIdByDraftName(
  skills: readonly {
    id: string;
    name: string;
    displayName: string | null;
  }[],
  draftTitle: string,
): string | null {
  const slug = toAssetName(draftTitle);
  const match = skills.find(
    (s) =>
      s.name === slug ||
      s.name === draftTitle ||
      (s.displayName !== null &&
        (s.displayName === draftTitle || toAssetName(s.displayName) === slug)),
  );
  return match?.id ?? null;
}

type DraftItem = {
  id: string;
  title: string;
  content: string;
  description: string | null;
  existingSkillId: string | null;
  files: { path: string; content: string }[];
  updatedAt: string;
  createdAt: string;
};

const draftsByOwner = new Map<string, DraftItem[]>();
const draftByOwnerAndId = new Map<string, DraftItem>();

const listSkillDrafts = mock(
  async (_db: unknown, _repoStore: unknown, ctx: { principalId: string }) =>
    draftsByOwner.get(ctx.principalId) ?? [],
);
const getOwnedSkillDraftItem = mock(
  async (
    _db: unknown,
    _repoStore: unknown,
    ctx: { principalId: string },
    draftId: string,
  ) => {
    const draft = draftByOwnerAndId.get(`${ctx.principalId}:${draftId}`);
    if (!draft) throw new Error(`Skill draft not found: ${draftId}`);
    return draft;
  },
);

const capturedDraftWrites: any[] = [];
const upsertSkillDraft = mock(
  async (
    _assetService: unknown,
    _db: unknown,
    _repoStore: unknown,
    input: any,
  ) => {
    capturedDraftWrites.push(input);
    return { draftId: "asset-draft-1" };
  },
);

mock.module("../services/skill-library", () => ({
  listSkills,
  getSkillAsset,
  getSkillContent,
  matchSkillIdByDraftName,
  toAssetName,
  listSkillDrafts,
  getOwnedSkillDraftItem,
  upsertSkillDraft,
}));

const resolveOwnerMemberPrincipalId = mock(
  async () => "prn_owner_1" as string | null,
);
mock.module("../lib/artifact-tools", () => ({
  resolveOwnerMemberPrincipalId,
}));

const { createSkillTools } = await import("./list-skills");

const principals = new Map<
  string,
  { id: string; tenantId: string; refId: string } | null
>();

function fakeDb() {
  return createFakeDrizzleQuery({
    findFirst: {
      principal: async () => principals.get("prn_1") ?? null,
    },
  }) as never;
}

function tools(principalId = "prn_1") {
  return createSkillTools({
    db: fakeDb(),
    repoStore: {} as never,
    assetService: {} as never,
    tenantId: "ten_1",
    principalId,
  });
}

function tool(name: string) {
  const found = tools().find((t) => t.definition.name === name);
  if (!found || found.kind !== "string")
    throw new Error(`missing tool ${name}`);
  return found;
}

beforeEach(() => {
  visibleByUser.clear();
  assetByIdForUser.clear();
  filesByAsset.clear();
  draftsByOwner.clear();
  draftByOwnerAndId.clear();
  principals.clear();
  principals.set("prn_1", { id: "prn_1", tenantId: "ten_1", refId: "usr_1" });
  listSkills.mockClear();
  getSkillAsset.mockClear();
  resolveOwnerMemberPrincipalId.mockClear();
  resolveOwnerMemberPrincipalId.mockImplementation(async () => "prn_owner_1");
  getSkillContent.mockClear();
  listSkillDrafts.mockClear();
  getOwnedSkillDraftItem.mockClear();
  upsertSkillDraft.mockClear();
  capturedDraftWrites.length = 0;
});

function draftFixture(over: Partial<DraftItem> = {}): DraftItem {
  const base: DraftItem = {
    id: "art_d1",
    title: "Deck Builder",
    content: "# Deck Builder\nBuild a deck.",
    description: "Turns notes into a deck",
    existingSkillId: null,
    files: [],
    updatedAt: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
  };
  return Object.assign(base, over);
}

describe("list_skill_drafts", () => {
  test("returns a body-less index of the owner's pending drafts", async () => {
    draftsByOwner.set("prn_owner_1", [
      draftFixture({ id: "art_d1", title: "Deck Builder" }),
      draftFixture({
        id: "art_d2",
        title: "Humanizer",
        description: null,
      }),
    ]);
    const result = await tool("list_skill_drafts").handler(
      {},
      new AbortController().signal,
    );
    expect(JSON.parse(result)).toEqual({
      drafts: [
        {
          id: "art_d1",
          name: "Deck Builder",
          description: "Turns notes into a deck",
        },
        { id: "art_d2", name: "Humanizer", description: null },
      ],
    });
    // Authorized against the resolved OWNER member principal, not the agent id.
    expect(listSkillDrafts).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { tenantId: "ten_1", principalId: "prn_owner_1" },
    );
  });

  test("fails closed to an empty list when there is no owning member principal", async () => {
    resolveOwnerMemberPrincipalId.mockImplementation(async () => null);
    draftsByOwner.set("prn_owner_1", [draftFixture()]);
    const result = await tool("list_skill_drafts").handler(
      {},
      new AbortController().signal,
    );
    expect(JSON.parse(result)).toEqual({ drafts: [] });
    expect(listSkillDrafts).not.toHaveBeenCalled();
  });
});

describe("load_skill_draft", () => {
  test("returns the draft body and support files for an owned draft", async () => {
    draftByOwnerAndId.set(
      "prn_owner_1:art_d1",
      draftFixture({
        id: "art_d1",
        title: "Deck Builder",
        content: "# Deck Builder\nBuild a deck.",
        files: [{ path: "examples/sample.md", content: "# sample" }],
      }),
    );
    const result = await tool("load_skill_draft").handler(
      { id: "art_d1" },
      new AbortController().signal,
    );
    expect(JSON.parse(result)).toMatchObject({
      id: "art_d1",
      name: "Deck Builder",
      description: "Turns notes into a deck",
      body: "# Deck Builder\nBuild a deck.",
      files: [{ path: "examples/sample.md", content: "# sample" }],
    });
    expect(getOwnedSkillDraftItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { tenantId: "ten_1", principalId: "prn_owner_1" },
      "art_d1",
    );
  });

  test("truncates an oversized draft body and flags it with a notice", async () => {
    const huge = "x".repeat(2 * 1024 * 1024);
    draftByOwnerAndId.set(
      "prn_owner_1:art_big",
      draftFixture({ id: "art_big", content: huge }),
    );
    const parsed = JSON.parse(
      await tool("load_skill_draft").handler(
        { id: "art_big" },
        new AbortController().signal,
      ),
    );
    expect(parsed.body.length).toBeLessThan(huge.length);
    expect(parsed.notice).toBeDefined();
  });

  test("errors when the draft is not owned by the caller", async () => {
    await expect(
      tool("load_skill_draft").handler(
        { id: "art_someone_else" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Skill draft not found: art_someone_else");
  });

  test("errors when there is no owning member principal", async () => {
    resolveOwnerMemberPrincipalId.mockImplementation(async () => null);
    draftByOwnerAndId.set("prn_owner_1:art_d1", draftFixture());
    await expect(
      tool("load_skill_draft").handler(
        { id: "art_d1" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Skill draft not found: art_d1");
    expect(getOwnedSkillDraftItem).not.toHaveBeenCalled();
  });

  test("rejects a missing id", async () => {
    await expect(
      tool("load_skill_draft").handler({}, new AbortController().signal),
    ).rejects.toThrow("load_skill_draft");
  });
});

describe("list_skills", () => {
  test("returns the index shape only — no skill body", async () => {
    visibleByUser.set("usr_1", [
      { id: "a1", name: "deck", displayName: "Deck" },
      { id: "a2", name: "humanize", displayName: null },
    ]);
    const result = await tool("list_skills").handler(
      {},
      new AbortController().signal,
    );
    expect(JSON.parse(result)).toEqual({
      skills: [
        { id: "a1", name: "deck", displayName: "Deck" },
        { id: "a2", name: "humanize", displayName: "Humanize" },
      ],
    });
    // Resolved the STABLE user id (refId), not the synthetic principal id.
    expect(listSkills).toHaveBeenCalledWith(expect.anything(), {
      tenantId: "ten_1",
      userId: "usr_1",
    });
  });

  test("humanizes a slug-shaped displayName instead of leaking the raw slug into the tool JSON", async () => {
    visibleByUser.set("usr_1", [
      { id: "a3", name: "landing-page", displayName: "landing-page" },
    ]);
    const result = await tool("list_skills").handler(
      {},
      new AbortController().signal,
    );
    expect(JSON.parse(result)).toEqual({
      skills: [{ id: "a3", name: "landing-page", displayName: "Landing page" }],
    });
  });

  test("fails closed to an empty list when the principal is not a resolvable user", async () => {
    principals.set("prn_1", null);
    visibleByUser.set("usr_1", [
      { id: "a1", name: "deck", displayName: "Deck" },
    ]);
    const result = await tool("list_skills").handler(
      {},
      new AbortController().signal,
    );
    expect(JSON.parse(result)).toEqual({ skills: [] });
    expect(listSkills).not.toHaveBeenCalled();
  });
});

describe("search_skills", () => {
  test("filters the visible index by the query", async () => {
    visibleByUser.set("usr_1", [
      { id: "a1", name: "deck-builder", displayName: "Deck Builder" },
      { id: "a2", name: "humanizer", displayName: "Humanizer" },
    ]);
    const result = await tool("search_skills").handler(
      { query: "deck" },
      new AbortController().signal,
    );
    expect(JSON.parse(result).skills.map((s: Skill) => s.id)).toEqual(["a1"]);
  });

  test("rejects a missing query", async () => {
    await expect(
      tool("search_skills").handler({}, new AbortController().signal),
    ).rejects.toThrow("search_skills");
  });
});

describe("load_skill", () => {
  test("returns the stripped body plus sibling files", async () => {
    assetByIdForUser.set("usr_1:a1", {
      id: "a1",
      name: "deck",
      displayName: "Deck",
    });
    filesByAsset.set("a1", [
      { path: "SKILL.md", content: "Build a deck." },
      { path: "examples/sample.md", content: "# sample" },
    ]);
    const result = await tool("load_skill").handler(
      { id: "a1" },
      new AbortController().signal,
    );
    expect(JSON.parse(result)).toEqual({
      id: "a1",
      name: "deck",
      displayName: "Deck",
      body: "Build a deck.",
      files: [{ path: "examples/sample.md", content: "# sample" }],
    });
  });

  test("truncates oversized content and flags binary siblings, with a notice", async () => {
    assetByIdForUser.set("usr_1:a1", {
      id: "a1",
      name: "deck",
      displayName: "Deck",
    });
    const huge = "x".repeat(2 * 1024 * 1024);
    filesByAsset.set("a1", [
      { path: "SKILL.md", content: huge },
      { path: "logo.png" }, // binary: no content
    ]);
    const parsed = JSON.parse(
      await tool("load_skill").handler(
        { id: "a1" },
        new AbortController().signal,
      ),
    );
    expect(parsed.body.length).toBeLessThan(huge.length);
    expect(parsed.notice).toBeDefined();
    const binary = parsed.files.find(
      (f: { path: string }) => f.path === "logo.png",
    );
    expect(binary.content).toBeUndefined();
    expect(binary.omitted).toContain("binary");
  });

  test("errors when the skill is not visible to the viewer", async () => {
    // No asset registered for usr_1 → getSkillAsset resolves null (the library's
    // visibility denial), and load must surface a not-found rather than content.
    await expect(
      tool("load_skill").handler(
        { id: "private_to_someone_else" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Skill not found: private_to_someone_else");
    expect(getSkillContent).not.toHaveBeenCalled();
  });

  test("errors when the principal is not a resolvable user", async () => {
    principals.set("prn_1", null);
    assetByIdForUser.set("usr_1:a1", {
      id: "a1",
      name: "deck",
      displayName: "Deck",
    });
    await expect(
      tool("load_skill").handler({ id: "a1" }, new AbortController().signal),
    ).rejects.toThrow("Skill not found: a1");
    expect(getSkillAsset).not.toHaveBeenCalled();
  });
});

describe("skill_draft", () => {
  test("parses name+body, upserts via the skill-library asset path, returns {draftId}", async () => {
    const resultJson = await tool("skill_draft").handler(
      { name: "my-skill", body: "export const run = () => {};" },
      new AbortController().signal,
    );
    const result = JSON.parse(resultJson);
    expect(result).toEqual({ draftId: "asset-draft-1" });
    expect(capturedDraftWrites).toHaveLength(1);
    expect(capturedDraftWrites[0]).toMatchObject({
      tenantId: "ten_1",
      ownerPrincipalId: "prn_owner_1",
      title: "my-skill",
      body: "export const run = () => {};",
    });
  });

  test("fails closed when agent has no owning member principal", async () => {
    resolveOwnerMemberPrincipalId.mockImplementation(async () => null);
    await expect(
      tool("skill_draft").handler(
        { name: "orphan", body: "body" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("no owning member principal");
    expect(capturedDraftWrites).toHaveLength(0);
  });

  test("passes optional description, files, existingSkillId through to the upsert", async () => {
    await tool("skill_draft").handler(
      {
        name: "revise-me",
        body: "body here",
        description: "does x",
        files: [{ path: "util.ts", content: "export {}" }],
        existingSkillId: "skl_abc",
      },
      new AbortController().signal,
    );
    expect(capturedDraftWrites[0]).toMatchObject({
      description: "does x",
      files: [{ path: "util.ts", content: "export {}" }],
      existingSkillId: "skl_abc",
    });
  });

  test("auto-resolves existingSkillId from a library skill with the same name", async () => {
    visibleByUser.set("usr_1", [
      { id: "skl_match", name: "my-skill", displayName: "My Skill" },
    ]);
    const resultJson = await tool("skill_draft").handler(
      { name: "my-skill", body: "revised body" },
      new AbortController().signal,
    );
    const result = JSON.parse(resultJson);
    expect(result.existingSkillId).toBe("skl_match");
    expect(capturedDraftWrites[0]).toMatchObject({
      existingSkillId: "skl_match",
    });
  });

  test("auto-resolves via toAssetName when draft title is display-ish", async () => {
    visibleByUser.set("usr_1", [
      {
        id: "skl_display",
        name: "company-research",
        displayName: "Company Research",
      },
    ]);
    const resultJson = await tool("skill_draft").handler(
      { name: "Company Research", body: "revised body" },
      new AbortController().signal,
    );
    expect(JSON.parse(resultJson).existingSkillId).toBe("skl_display");
    expect(capturedDraftWrites[0]).toMatchObject({
      existingSkillId: "skl_display",
    });
  });

  test("throws on missing required fields via parser", async () => {
    await expect(
      tool("skill_draft").handler(
        { name: "onlyname" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("skill_draft");
  });
});
