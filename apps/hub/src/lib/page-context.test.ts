/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  appendPageContextToPrompt,
  MAX_PAGE_CONTEXT_LENGTH,
  normalizePageContextInput,
} from "./page-context";

describe("normalizePageContextInput", () => {
  it("trims and drops empty strings", () => {
    expect(normalizePageContextInput(undefined)).toBeUndefined();
    expect(normalizePageContextInput("  ")).toBeUndefined();
    expect(normalizePageContextInput(" Inbox home ")).toBe("Inbox home");
  });

  it("caps length", () => {
    const long = "a".repeat(MAX_PAGE_CONTEXT_LENGTH + 100);
    expect(normalizePageContextInput(long)?.length).toBe(MAX_PAGE_CONTEXT_LENGTH);
  });
});

describe("appendPageContextToPrompt", () => {
  it("adds a page_context section for OpenAI-style providers", () => {
    const out = appendPageContextToPrompt(
      "You are Myra.",
      "Inbox: triage feed.",
      "openai",
    );
    expect(out).toContain("You are Myra.");
    expect(out).toContain("Page_context");
    expect(out).toContain("Inbox: triage feed.");
  });
});