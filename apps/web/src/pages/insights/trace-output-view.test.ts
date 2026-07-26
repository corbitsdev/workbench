/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  classifyTraceValue,
  looksLikeMarkdown,
  stringifyTraceValue,
} from "./trace-output-format";

describe("classifyTraceValue", () => {
  it("detects markdown strings", () => {
    expect(classifyTraceValue("# Title\n\nBody.")).toBe("markdown");
  });

  it("detects JSON objects and arrays", () => {
    expect(classifyTraceValue({ a: 1 })).toBe("json");
    expect(classifyTraceValue([1, 2])).toBe("json");
  });

  it("parses JSON-looking strings as json", () => {
    expect(classifyTraceValue('{"x":1}')).toBe("json");
  });
});

describe("looksLikeMarkdown", () => {
  it("returns false for plain one-liners", () => {
    expect(looksLikeMarkdown("hello")).toBe(false);
  });
});

describe("stringifyTraceValue", () => {
  it("pretty-prints in formatted mode", () => {
    expect(stringifyTraceValue({ a: 1 }, "formatted")).toBe('{\n  "a": 1\n}');
  });

  it("compacts in raw mode", () => {
    expect(stringifyTraceValue({ a: 1 }, "raw")).toBe('{"a":1}');
  });
});
