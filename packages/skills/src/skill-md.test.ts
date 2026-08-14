import { describe, expect, test } from "bun:test";

import {
  buildSkillMd,
  parseSkillMd,
  SkillContentError,
  decodeSkillMd,
} from "./skill-md";

describe("buildSkillMd", () => {
  test("round-trips name, description, and body", () => {
    const md = buildSkillMd({
      name: "summarize-transcript",
      description: "Condenses a meeting transcript into decisions and owners.",
      body: "1. Read the transcript.\n2. List every decision.",
    });
    const parsed = parseSkillMd(md);
    expect(parsed.name).toBe("summarize-transcript");
    expect(parsed.description).toBe(
      "Condenses a meeting transcript into decisions and owners.",
    );
    expect(parsed.body).toBe(
      "1. Read the transcript.\n2. List every decision.",
    );
  });

  test("quotes a description containing a colon so the frontmatter stays one mapping", () => {
    const md = buildSkillMd({
      name: "triage",
      description: "Sorts issues: bug, question, or feature.",
      body: "Sort them.",
    });
    expect(parseSkillMd(md).description).toBe(
      "Sorts issues: bug, question, or feature.",
    );
  });

  test("preserves an apostrophe through the single-quoted scalar", () => {
    const md = buildSkillMd({
      name: "triage",
      description: "Reads the reporter's own words first.",
      body: "Sort them.",
    });
    expect(parseSkillMd(md).description).toBe(
      "Reads the reporter's own words first.",
    );
  });

  test("rejects a name the hub's skill kind handler would reject", () => {
    expect(() =>
      buildSkillMd({
        name: "Summarize Transcript",
        description: "Anything.",
        body: "Body.",
      }),
    ).toThrow(SkillContentError);
  });

  test("rejects the reserved vendor names", () => {
    expect(() =>
      buildSkillMd({ name: "claude", description: "Anything.", body: "Body." }),
    ).toThrow(SkillContentError);
  });

  test("rejects a description carrying HTML tags", () => {
    expect(() =>
      buildSkillMd({
        name: "triage",
        description: "Sorts <b>issues</b>.",
        body: "Body.",
      }),
    ).toThrow(SkillContentError);
  });

  test("rejects an empty body", () => {
    expect(() =>
      buildSkillMd({ name: "triage", description: "Sorts.", body: "   " }),
    ).toThrow(SkillContentError);
  });
});

describe("parseSkillMd", () => {
  test("rejects content with no frontmatter", () => {
    expect(() => parseSkillMd("just a body")).toThrow(SkillContentError);
  });

  test("rejects frontmatter with no closing delimiter", () => {
    expect(() => parseSkillMd("---\nname: triage\n")).toThrow(
      SkillContentError,
    );
  });

  test("rejects frontmatter missing a description", () => {
    expect(() => parseSkillMd("---\nname: triage\n---\nBody")).toThrow(
      SkillContentError,
    );
  });

  test("ignores optional frontmatter keys the Claude Code superset allows", () => {
    const parsed = parseSkillMd(
      "---\nname: triage\ndescription: Sorts issues.\nmodel: any\n---\nBody",
    );
    expect(parsed.name).toBe("triage");
    expect(parsed.body).toBe("Body");
  });

  test("decodeSkillMd reads raw asset bytes", () => {
    const bytes = new TextEncoder().encode(
      "---\nname: triage\ndescription: Sorts issues.\n---\nBody",
    );
    expect(decodeSkillMd(bytes).name).toBe("triage");
  });
});
