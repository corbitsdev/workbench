import { describe, expect, it } from "bun:test";
import {
  DRAFT_SKILL_DEFINITION,
  LIST_SKILL_DRAFTS_DEFINITION,
  LIST_SKILLS_DEFINITION,
  LOAD_SKILL_DEFINITION,
  LOAD_SKILL_DRAFT_DEFINITION,
  SEARCH_SKILLS_DEFINITION,
  SKILL_TOOL_DEFINITIONS,
  parseDraftSkillArgs,
  parseSearchQuery,
  parseSkillDraftId,
  parseSkillId,
  skillMatchesQuery,
  type SkillIndexEntry,
} from "./index";

describe("skill tool definitions", () => {
  it("exposes the read tools, the draft read tools, plus skill_draft", () => {
    expect(SKILL_TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual([
      "list_skill_drafts",
      "list_skills",
      "load_skill",
      "load_skill_draft",
      "search_skills",
      "skill_draft",
    ]);
  });

  it("list_skills and list_skill_drafts take no required args", () => {
    expect(LIST_SKILLS_DEFINITION.inputSchema.required).toEqual([]);
    expect(LIST_SKILL_DRAFTS_DEFINITION.inputSchema.required).toEqual([]);
  });

  it("search_skills requires query, load_skill/load_skill_draft require id, skill_draft requires name+body", () => {
    expect(SEARCH_SKILLS_DEFINITION.inputSchema.required).toEqual(["query"]);
    expect(LOAD_SKILL_DEFINITION.inputSchema.required).toEqual(["id"]);
    expect(LOAD_SKILL_DRAFT_DEFINITION.inputSchema.required).toEqual(["id"]);
    expect(DRAFT_SKILL_DEFINITION.inputSchema.required).toEqual([
      "name",
      "body",
    ]);
  });

  it("list_skill_drafts description points at pending drafts and load_skill_draft", () => {
    expect(LIST_SKILL_DRAFTS_DEFINITION.description).toContain("pending");
    expect(LIST_SKILL_DRAFTS_DEFINITION.description).toContain(
      "load_skill_draft",
    );
  });

  it("skill_draft description points humans at Skills → Pending drafts", () => {
    expect(DRAFT_SKILL_DEFINITION.description).toContain(
      "Skills → Pending drafts",
    );
  });
});

describe("parseSearchQuery", () => {
  it("returns the query string", () => {
    expect(parseSearchQuery({ query: "deck" })).toBe("deck");
  });

  it("throws on a missing query", () => {
    expect(() => parseSearchQuery({})).toThrow("search_skills");
  });

  it("throws on an empty query", () => {
    expect(() => parseSearchQuery({ query: "" })).toThrow("search_skills");
  });

  it("throws on a non-string query", () => {
    expect(() => parseSearchQuery({ query: 7 })).toThrow("search_skills");
  });
});

describe("parseSkillId", () => {
  it("returns the id string", () => {
    expect(parseSkillId({ id: "asset_1" })).toBe("asset_1");
  });

  it("throws on a missing id", () => {
    expect(() => parseSkillId({})).toThrow("load_skill");
  });

  it("throws on an empty id", () => {
    expect(() => parseSkillId({ id: "" })).toThrow("load_skill");
  });
});

describe("parseSkillDraftId", () => {
  it("returns the id string", () => {
    expect(parseSkillDraftId({ id: "art_1" })).toBe("art_1");
  });

  it("throws on a missing id", () => {
    expect(() => parseSkillDraftId({})).toThrow("load_skill_draft");
  });

  it("throws on an empty id", () => {
    expect(() => parseSkillDraftId({ id: "" })).toThrow("load_skill_draft");
  });
});

describe("skillMatchesQuery", () => {
  const entry: SkillIndexEntry = {
    id: "a1",
    name: "deck-builder",
    displayName: "Deck Builder",
  };

  it("matches a substring of the name (case-insensitive)", () => {
    expect(skillMatchesQuery(entry, "DECK")).toBe(true);
  });

  it("matches a substring of the display name (case-insensitive)", () => {
    expect(skillMatchesQuery(entry, "deck builder")).toBe(true);
  });

  it("does not match an unrelated query", () => {
    expect(skillMatchesQuery(entry, "spreadsheet")).toBe(false);
  });

  it("treats a blank query as matching everything", () => {
    expect(skillMatchesQuery(entry, "   ")).toBe(true);
  });

  it("tolerates a null displayName", () => {
    const sparse: SkillIndexEntry = {
      id: "a2",
      name: "lonely",
      displayName: null,
    };
    expect(skillMatchesQuery(sparse, "lonely")).toBe(true);
    expect(skillMatchesQuery(sparse, "nope")).toBe(false);
  });
});

describe("parseDraftSkillArgs", () => {
  it("parses valid args (whitespace preserved, like other parsers)", () => {
    expect(parseDraftSkillArgs({ name: "foo", body: "bar" })).toEqual({
      name: "foo",
      body: "bar",
    });
    expect(
      parseDraftSkillArgs({ name: "  FOO ", body: " baz ", description: "d" }),
    ).toEqual({
      name: "  FOO ",
      body: " baz ",
      description: "d",
    });
  });

  it("throws on invalid draft args (missing/empty name or body)", () => {
    expect(() => parseDraftSkillArgs({ name: "n", body: "" })).toThrow(
      "skill_draft",
    );
    expect(() => parseDraftSkillArgs({ name: "", body: "b" })).toThrow(
      "skill_draft",
    );
    expect(() => parseDraftSkillArgs({ name: "n" })).toThrow("skill_draft");
    expect(() => parseDraftSkillArgs({ body: "b" })).toThrow("skill_draft");
  });
});
