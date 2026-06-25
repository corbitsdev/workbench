/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  LINKEDIN_LINE_BREAK_ANCHOR,
  formatLinkedInPostForClipboard,
  resolveArtifactClipboardText,
} from "./linkedin-clipboard";

describe("formatLinkedInPostForClipboard", () => {
  it("inserts invisible anchors on blank lines between paragraphs", () => {
    const input = "Hook line\n\nSecond paragraph.\n\nFinal line.";
    const expected = `Hook line\n${LINKEDIN_LINE_BREAK_ANCHOR}\nSecond paragraph.\n${LINKEDIN_LINE_BREAK_ANCHOR}\nFinal line.`;
    expect(formatLinkedInPostForClipboard(input)).toBe(expected);
  });

  it("normalizes Windows line endings before formatting", () => {
    const input = "Line one\r\n\r\nLine two";
    const expected = `Line one\n${LINKEDIN_LINE_BREAK_ANCHOR}\nLine two`;
    expect(formatLinkedInPostForClipboard(input)).toBe(expected);
  });

  it("treats whitespace-only lines as blank", () => {
    const input = "Line one\n   \nLine two";
    const expected = `Line one\n${LINKEDIN_LINE_BREAK_ANCHOR}\nLine two`;
    expect(formatLinkedInPostForClipboard(input)).toBe(expected);
  });

  it("leaves single-line content unchanged", () => {
    expect(formatLinkedInPostForClipboard("One paragraph only.")).toBe(
      "One paragraph only.",
    );
  });

  it("is idempotent when anchors are already present", () => {
    const alreadyFormatted = `Hook\n${LINKEDIN_LINE_BREAK_ANCHOR}\nBody`;
    expect(formatLinkedInPostForClipboard(alreadyFormatted)).toBe(
      alreadyFormatted,
    );
  });

  it("drops trailing blank lines instead of anchoring them", () => {
    expect(formatLinkedInPostForClipboard("Hook line\n\n")).toBe("Hook line");
    expect(formatLinkedInPostForClipboard("Hook line\n\nSecond.\n\n")).toBe(
      `Hook line\n${LINKEDIN_LINE_BREAK_ANCHOR}\nSecond.`,
    );
  });

  it("drops leading blank lines instead of anchoring them", () => {
    expect(formatLinkedInPostForClipboard("\n\nHook line")).toBe("Hook line");
  });

  it("preserves internal runs of blank lines as anchors", () => {
    expect(formatLinkedInPostForClipboard("A\n\n\nB")).toBe(
      `A\n${LINKEDIN_LINE_BREAK_ANCHOR}\n${LINKEDIN_LINE_BREAK_ANCHOR}\nB`,
    );
  });
});

describe("resolveArtifactClipboardText", () => {
  it("formats linkedin-post content when the manual gate is enabled", () => {
    const input = "Hook\n\nBody";
    const expected = `Hook\n${LINKEDIN_LINE_BREAK_ANCHOR}\nBody`;
    expect(resolveArtifactClipboardText(input, "linkedin-post", true)).toBe(
      expected,
    );
  });

  it("returns raw content when the manual gate is disabled", () => {
    const input = "Hook\n\nBody";
    expect(resolveArtifactClipboardText(input, "linkedin-post", false)).toBe(
      input,
    );
  });

  it("returns raw content for non-linkedin kinds even when the gate is enabled", () => {
    const input = "Hook\n\nBody";
    expect(resolveArtifactClipboardText(input, "email", true)).toBe(input);
  });
});
