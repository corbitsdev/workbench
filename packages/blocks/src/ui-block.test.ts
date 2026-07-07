/// <reference types="bun" />
import { describe, expect, it } from "bun:test";

import { extractUIBlockFromText, isUIBlock, parseToolResult } from "./ui-block";

describe("parseToolResult", () => {
  it("parses a JSON object matching the UIBlock shape", () => {
    const result = parseToolResult(
      '{"kind":"document","title":"Call","source":"# Hi"}',
    );
    expect(result.kind).toBe("document");
    if (result.kind === "document") {
      expect(result.title).toBe("Call");
      expect(result.source).toBe("# Hi");
    }
  });

  it("degrades malformed JSON to a text block carrying the raw string", () => {
    const raw = '{"kind":"document", oops not json';
    const result = parseToolResult(raw);
    expect(result.kind).toBe("text");
    if (result.kind === "text") expect(result.text).toBe(raw);
  });

  it("degrades valid JSON with an unknown kind to a text block", () => {
    const raw = '{"kind":"banana"}';
    const result = parseToolResult(raw);
    expect(result.kind).toBe("text");
  });

  it("treats a plain string result as a text block (no regression)", () => {
    const raw = "# Call: ABK\nDate: 2026-06-10";
    const result = parseToolResult(raw);
    expect(result.kind).toBe("text");
    if (result.kind === "text") expect(result.text).toBe(raw);
  });

  it("rejects a JSON block missing required fields for its kind", () => {
    // document without a source is not renderable -> text fallback
    const result = parseToolResult('{"kind":"document","title":"x"}');
    expect(result.kind).toBe("text");
  });
});

describe("extractUIBlockFromText", () => {
  it("extracts a fenced ui block and returns the surrounding prose", () => {
    const content = [
      "Here's your latest call.",
      "```ui",
      '{"kind":"document","title":"ABK Demo","source":"# Call"}',
      "```",
      "Anything else?",
    ].join("\n");
    const extracted = extractUIBlockFromText(content);
    expect(extracted).not.toBeNull();
    expect(extracted?.block.kind).toBe("document");
    expect(extracted?.text).toBe("Here's your latest call.\n\nAnything else?");
  });

  it("returns null when there is no ui fence", () => {
    expect(extractUIBlockFromText("just a normal reply")).toBeNull();
  });

  it("returns null when the fenced content is not a valid block", () => {
    const content = '```ui\n{"kind":"nope"}\n```';
    expect(extractUIBlockFromText(content)).toBeNull();
  });
});

describe("isUIBlock", () => {
  it("accepts a well-formed choice block", () => {
    expect(
      isUIBlock({ kind: "choice", options: [{ id: "a", label: "A" }] }),
    ).toBe(true);
  });

  it("rejects a choice block with no options", () => {
    expect(isUIBlock({ kind: "choice", options: [] })).toBe(false);
  });

  it("rejects a choice block whose options lack id or label strings", () => {
    expect(isUIBlock({ kind: "choice", options: [null] })).toBe(false);
    expect(
      isUIBlock({ kind: "choice", options: [{ id: 1, label: "A" }] }),
    ).toBe(false);
    expect(isUIBlock({ kind: "choice", options: [{ id: "a" }] })).toBe(false);
  });

  it("accepts a canvas block with nested valid blocks", () => {
    expect(
      isUIBlock({
        kind: "canvas",
        blocks: [
          { kind: "text", text: "hello" },
          { kind: "markdown", source: "# Hi" },
        ],
      }),
    ).toBe(true);
  });

  it("rejects a canvas block containing an invalid nested block", () => {
    expect(
      isUIBlock({
        kind: "canvas",
        blocks: [
          { kind: "text", text: "ok" },
          { kind: "text", text: 99 },
        ],
      }),
    ).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isUIBlock("string")).toBe(false);
    expect(isUIBlock(null)).toBe(false);
  });

  it("rejects an object with no kind discriminant", () => {
    expect(isUIBlock({ title: "x" })).toBe(false);
  });

  it("accepts each well-formed variant", () => {
    expect(isUIBlock({ kind: "text", text: "hi" })).toBe(true);
    expect(isUIBlock({ kind: "markdown", source: "# x" })).toBe(true);
    expect(isUIBlock({ kind: "table", columns: ["a"], rows: [["1"]] })).toBe(
      true,
    );
    expect(isUIBlock({ kind: "link", url: "https://x.dev" })).toBe(true);
    expect(isUIBlock({ kind: "error", message: "boom" })).toBe(true);
    expect(isUIBlock({ kind: "canvas", blocks: [] })).toBe(true);
  });

  it("rejects each variant when its required field is the wrong type", () => {
    expect(isUIBlock({ kind: "text", text: 5 })).toBe(false);
    expect(isUIBlock({ kind: "markdown", source: 5 })).toBe(false);
    expect(isUIBlock({ kind: "table", columns: "a", rows: [] })).toBe(false);
    expect(
      isUIBlock({ kind: "table", columns: ["a"], rows: [[{ x: 1 }]] }),
    ).toBe(false);
    expect(
      isUIBlock({ kind: "table", columns: ["a"], rows: [null] }),
    ).toBe(false);
    expect(isUIBlock({ kind: "link", url: 5 })).toBe(false);
    expect(isUIBlock({ kind: "error", message: 5 })).toBe(false);
    expect(isUIBlock({ kind: "canvas", blocks: "x" })).toBe(false);
  });
});

describe("isUIBlock progress variant", () => {
  it("accepts a well-formed progress block", () => {
    expect(
      isUIBlock({
        kind: "progress",
        steps: [
          { label: "Fetch calls", state: "done" },
          { label: "Draft", state: "running", meta: "2 of 5" },
          { label: "Review", state: "pending" },
        ],
      }),
    ).toBe(true);
  });

  it("accepts every step state", () => {
    for (const state of ["done", "running", "awaiting", "pending", "failed"]) {
      expect(
        isUIBlock({ kind: "progress", steps: [{ label: "x", state }] }),
      ).toBe(true);
    }
  });

  it("rejects a progress block with no steps", () => {
    expect(isUIBlock({ kind: "progress", steps: [] })).toBe(false);
    expect(isUIBlock({ kind: "progress" })).toBe(false);
    expect(isUIBlock({ kind: "progress", steps: "x" })).toBe(false);
  });

  it("rejects a step with an unknown state or wrong field types", () => {
    expect(
      isUIBlock({
        kind: "progress",
        steps: [{ label: "x", state: "paused" }],
      }),
    ).toBe(false);
    expect(
      isUIBlock({ kind: "progress", steps: [{ label: 5, state: "done" }] }),
    ).toBe(false);
    expect(
      isUIBlock({
        kind: "progress",
        steps: [{ label: "x", state: "done", meta: 5 }],
      }),
    ).toBe(false);
    expect(isUIBlock({ kind: "progress", steps: [null] })).toBe(false);
  });

  it("degrades a malformed progress tool result to text without throwing", () => {
    const raw = '{"kind":"progress","steps":[{"label":"x","state":"nope"}]}';
    const result = parseToolResult(raw);
    expect(result.kind).toBe("text");
    if (result.kind === "text") expect(result.text).toBe(raw);
  });
});

describe("parseToolResult array path", () => {
  it("degrades a JSON array that is not a UIBlock to a text block", () => {
    const raw = "[1, 2, 3]";
    const result = parseToolResult(raw);
    expect(result.kind).toBe("text");
    if (result.kind === "text") expect(result.text).toBe(raw);
  });
});
