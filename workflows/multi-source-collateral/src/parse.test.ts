import { describe, expect, test } from "bun:test";
import {
  buildSourceContext,
  extractArtifactText,
  extractIssueText,
  extractNoteText,
  mapOutputsArray,
  parseArtifactList,
  parseGeneratedPieces,
  parseIssueList,
  parseNoteList,
} from "./parse";

describe("list parsers", () => {
  test("artifact list unwraps result wrapper", () => {
    const r = parseArtifactList({
      result: { artifacts: [{ id: "a", title: "T" }] },
    });
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.value[0]?.id).toBe("a");
  });

  test("note list accepts items key", () => {
    const r = parseNoteList({ items: [{ id: "n1" }] });
    expect(r.status).toBe("ok");
  });

  test("issue list accepts nodes key", () => {
    const r = parseIssueList({ nodes: [{ id: "x", identifier: "CL-9" }] });
    expect(r.status).toBe("ok");
  });
});

describe("extractors", () => {
  test("extractArtifactText prefers content fields", () => {
    expect(extractArtifactText({ title: "T", content: "body" })).toContain(
      "body",
    );
  });

  test("extractNoteText prefers transcript", () => {
    expect(extractNoteText({ title: "Call", transcript: "hello" })).toContain(
      "hello",
    );
  });

  test("extractIssueText uses identifier", () => {
    expect(
      extractIssueText({
        identifier: "CL-1",
        title: "Ship",
        description: "desc",
      }),
    ).toContain("CL-1");
  });
});

describe("mapOutputsArray + generated pieces", () => {
  test("mapOutputsArray reads results", () => {
    expect(mapOutputsArray({ results: [1, 2] })).toEqual([1, 2]);
  });

  test("parseGeneratedPieces from nested text JSON", () => {
    const pieces = parseGeneratedPieces({
      text: JSON.stringify({
        format: "blog-mid",
        title: "Mid",
        content: "Longer body",
      }),
    });
    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.format).toBe("blog-mid");
  });

  test("buildSourceContext empty when no inputs", () => {
    expect(buildSourceContext({})).toBe("");
  });
});
