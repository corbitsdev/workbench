import { describe, expect, test } from "bun:test";
import {
  classifyCall,
  granolaCallArtifactTitle,
  granolaCallSourceRef,
  granolaTaskSourceRef,
  GRANOLA_CALL_ARTIFACT_KINDS,
  parseCallAnalysis,
  stripJsonFences,
} from "./granola-call";

describe("classifyCall", () => {
  test("all attendees on the tenant domain is internal", () => {
    expect(classifyCall(["a@corbits.io", "b@corbits.io"], "corbits.io")).toBe(
      "internal",
    );
  });

  test("any off-domain attendee is external", () => {
    expect(classifyCall(["a@corbits.io", "c@acme.com"], "corbits.io")).toBe(
      "external",
    );
  });

  test("no attendee emails is unknown", () => {
    expect(classifyCall(["Alice", "Bob"], "corbits.io")).toBe("unknown");
  });

  test("empty participants is unknown", () => {
    expect(classifyCall([], "corbits.io")).toBe("unknown");
  });

  test("empty tenant domain is unknown", () => {
    expect(classifyCall(["a@corbits.io", "b@acme.com"], "")).toBe("unknown");
    expect(classifyCall(["a@corbits.io"], "   ")).toBe("unknown");
  });

  test("tenant domain comparison is case-insensitive", () => {
    expect(classifyCall(["a@Corbits.IO"], "CORBITS.IO")).toBe("internal");
  });
});

describe("granolaCallSourceRef", () => {
  test("formats note id and kind", () => {
    expect(
      granolaCallSourceRef("note-1", GRANOLA_CALL_ARTIFACT_KINDS.painPoints),
    ).toBe("granola:call:note-1:granola-call-pain-points");
    expect(
      granolaCallSourceRef("note-1", GRANOLA_CALL_ARTIFACT_KINDS.summary),
    ).toBe("granola:call:note-1:granola-call-summary");
    expect(
      granolaCallSourceRef("note-1", GRANOLA_CALL_ARTIFACT_KINDS.brief),
    ).toBe("granola:call:note-1:granola-call-brief");
  });
});

describe("granolaTaskSourceRef", () => {
  test("formats note id and stable task index", () => {
    expect(granolaTaskSourceRef("note-1", 0)).toBe(
      "granola:call:note-1:task:0",
    );
    expect(granolaTaskSourceRef("note-1", 3)).toBe(
      "granola:call:note-1:task:3",
    );
  });
});

describe("granolaCallArtifactTitle", () => {
  test("joins title and suffix", () => {
    expect(granolaCallArtifactTitle("Acme discovery", "Pain Points")).toBe(
      "Acme discovery — Pain Points",
    );
  });

  test("falls back to Call when title is missing or blank", () => {
    expect(granolaCallArtifactTitle(null, "Summary")).toBe("Call — Summary");
    expect(granolaCallArtifactTitle(undefined, "Brief")).toBe("Call — Brief");
    expect(granolaCallArtifactTitle("   ", "Brief")).toBe("Call — Brief");
  });
});

describe("stripJsonFences", () => {
  test("unwraps fenced json blocks", () => {
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test("returns plain text unchanged", () => {
    expect(stripJsonFences('{"a":1}')).toBe('{"a":1}');
  });
});

describe("parseCallAnalysis", () => {
  const valid = {
    summary: "Discussed onboarding.",
    painPoints: ["Slow setup"],
    decisions: ["Ship quickstart"],
    actionItems: [{ description: "Draft docs", assignee: "alice@corbits.io" }],
    tasks: [{ description: "Write guide" }],
    peopleMentioned: ["Bob"],
  };

  test("parses and validates plain JSON", () => {
    const out = parseCallAnalysis(JSON.stringify(valid));
    expect(out.summary).toBe("Discussed onboarding.");
    expect(out.painPoints).toEqual(["Slow setup"]);
    expect(out.actionItems[0]?.assignee).toBe("alice@corbits.io");
  });

  test("strips code fences before parsing", () => {
    const fenced = "```json\n" + JSON.stringify(valid) + "\n```";
    const out = parseCallAnalysis(fenced);
    expect(out.summary).toBe("Discussed onboarding.");
  });

  test("throws on non-JSON output", () => {
    expect(() => parseCallAnalysis("not json at all")).toThrow(
      "Call analysis returned non-JSON output",
    );
  });

  test("throws on schema validation failure", () => {
    expect(() =>
      parseCallAnalysis(JSON.stringify({ summary: "only summary" })),
    ).toThrow(/Call analysis JSON failed validation/);
  });
});
