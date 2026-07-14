import { describe, expect, it } from "bun:test";
import {
  attachmentCapability,
  acceptedMimeTypes,
} from "./attachment-capabilities";

describe("attachmentCapability", () => {
  it("grants images+pdf on the anthropic adapter (marshals document blocks)", () => {
    expect(attachmentCapability("anthropic", "claude-opus-4-8")).toBe(
      "images+pdf",
    );
    expect(attachmentCapability("anthropic", "claude-sonnet-4-6")).toBe(
      "images+pdf",
    );
  });

  it("grants images+pdf on the google-genai adapter", () => {
    expect(attachmentCapability("google-genai", "gemini-3.1-pro")).toBe(
      "images+pdf",
    );
    expect(attachmentCapability("google-genai", "gemini-2.5-flash")).toBe(
      "images+pdf",
    );
  });

  it("grants images-only on openai adapters for a vision model (adapter throws on documents)", () => {
    // Plain `openai` plugin throws on documents in the same adapter file.
    expect(attachmentCapability("openai", "gpt-5.5")).toBe("images-only");
  });

  it("disables native attachments for text-only openai-compatible models", () => {
    expect(attachmentCapability("openai-compatible", "deepseek-v4-flash")).toBe(
      "none",
    );
    // Kimi K2 rides the openai-compatible endpoint, which rejects image_url
    // parts with HTTP 400 — it is NOT vision-capable, so images must divert
    // through the File Parser rather than ride inline.
    expect(attachmentCapability("openai-compatible", "kimi-k2.6")).toBe("none");
  });

  it("fails closed to none for an unknown model on a non-document adapter", () => {
    expect(attachmentCapability("openai-compatible", "mystery-model")).toBe(
      "none",
    );
  });
});

describe("acceptedMimeTypes", () => {
  it("returns nothing for none", () => {
    expect(acceptedMimeTypes("none")).toEqual([]);
  });

  it("returns image types but not pdf for images-only", () => {
    const set = acceptedMimeTypes("images-only");
    expect(set).toContain("image/png");
    expect(set).toContain("image/jpeg");
    expect(set).not.toContain("application/pdf");
    expect(set).not.toContain("video/mp4");
  });

  it("returns image types plus pdf for images+pdf", () => {
    const set = acceptedMimeTypes("images+pdf");
    expect(set).toContain("image/png");
    expect(set).toContain("application/pdf");
    // Non-image, non-pdf document types are deferred; audio/video never allowed.
    expect(set).not.toContain("text/csv");
    expect(set).not.toContain("audio/mpeg");
  });
});
