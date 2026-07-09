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

mock.module("../services/skill-library", () => ({
  listSkills,
  getSkillAsset,
  getSkillContent,
}));

const resolveOwnerMemberPrincipalId = mock(
  async () => "prn_owner_1" as string | null,
);
mock.module("../lib/artifact-tools", () => ({
  resolveOwnerMemberPrincipalId,
}));

const capturedDraftWrites: any[] = [];
mock.module("./write-artifact", () => ({
  writeArtifactDeduped: mock(async (params: any) => {
    capturedDraftWrites.push(params);
    return { artifactId: "art-draft-1", version: 3 };
  }),
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
  principals.clear();
  principals.set("prn_1", { id: "prn_1", tenantId: "ten_1", refId: "usr_1" });
  listSkills.mockClear();
  getSkillAsset.mockClear();
  resolveOwnerMemberPrincipalId.mockClear();
  resolveOwnerMemberPrincipalId.mockImplementation(async () => "prn_owner_1");
  getSkillContent.mockClear();
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
        { id: "a2", name: "humanize", displayName: null },
      ],
    });
    // Resolved the STABLE user id (refId), not the synthetic principal id.
    expect(listSkills).toHaveBeenCalledWith(expect.anything(), {
      tenantId: "ten_1",
      userId: "usr_1",
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
  test("parses name+body, writes as kind=skill-draft, returns {draftId, version}", async () => {
    capturedDraftWrites.length = 0;
    const resultJson = await tool("skill_draft").handler(
      { name: "my-skill", body: "export const run = () => {};" },
      new AbortController().signal,
    );
    const result = JSON.parse(resultJson);
    expect(result).toEqual({ draftId: "art-draft-1", version: 3 });
    expect(capturedDraftWrites).toHaveLength(1);
    expect(capturedDraftWrites[0]).toMatchObject({
      tenantId: "ten_1",
      principalId: "prn_1",
      ownerPrincipalId: "prn_owner_1",
      title: "my-skill",
      body: "export const run = () => {};",
      kind: "skill-draft",
    });
    expect(capturedDraftWrites[0].source).toEqual({ origin: "skill-draft" });
  });

  test("fails closed when agent has no owning member principal", async () => {
    capturedDraftWrites.length = 0;
    resolveOwnerMemberPrincipalId.mockImplementation(async () => null);
    await expect(
      tool("skill_draft").handler(
        { name: "orphan", body: "body" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("no owning member principal");
    expect(capturedDraftWrites).toHaveLength(0);
  });

  test("includes optional description, files, existingSkillId in source", async () => {
    capturedDraftWrites.length = 0;
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
    expect(capturedDraftWrites[0]?.source).toEqual({
      origin: "skill-draft",
      description: "does x",
      files: [{ path: "util.ts", content: "export {}" }],
      existingSkillId: "skl_abc",
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
