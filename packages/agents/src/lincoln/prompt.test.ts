import { describe, expect, it } from "bun:test";
import { buildLincolnSystemPrompt } from "./prompt";

describe("buildLincolnSystemPrompt", () => {
  it("includes the agent name in the identity section", () => {
    const prompt = buildLincolnSystemPrompt("Lincoln");
    expect(prompt).toContain("<identity>");
    expect(prompt).toContain("Lincoln");
  });

  it("uses the provided name, not a hardcoded string", () => {
    const prompt = buildLincolnSystemPrompt("CustomName");
    expect(prompt).toContain("CustomName");
  });

  it("includes the role section from LINKEDIN_WRITING_SECTIONS", () => {
    const prompt = buildLincolnSystemPrompt("Lincoln");
    expect(prompt).toContain("<role>");
    expect(prompt).toContain("practitioner");
  });

  it("includes structure guidance from LINKEDIN_WRITING_SECTIONS", () => {
    const prompt = buildLincolnSystemPrompt("Lincoln");
    expect(prompt).toContain("<structure>");
    expect(prompt).toContain("concrete observation");
  });

  it("includes formatting rules from LINKEDIN_WRITING_SECTIONS", () => {
    const prompt = buildLincolnSystemPrompt("Lincoln");
    expect(prompt).toContain("<formatting>");
    expect(prompt).toContain("No hashtags");
  });

  it("includes voice rules from LINKEDIN_WRITING_SECTIONS", () => {
    const prompt = buildLincolnSystemPrompt("Lincoln");
    expect(prompt).toContain("<voice>");
    expect(prompt).toContain("buzzwords");
  });

  it("includes the inputs section documenting accepted dynamic inputs", () => {
    const prompt = buildLincolnSystemPrompt("Lincoln");
    expect(prompt).toContain("<inputs>");
    expect(prompt).toContain("topic");
    expect(prompt).toContain("audience");
    expect(prompt).toContain("contextUrls");
    expect(prompt).toContain("toneNotes");
    expect(prompt).toContain("sellerName");
    expect(prompt).toContain("sellerCompany");
  });

  it("includes the memory section, honest about having no durable memory tool", () => {
    const prompt = buildLincolnSystemPrompt("Lincoln");
    expect(prompt).toContain("<memory>");
    expect(prompt).toContain("do not have a durable cross-session memory tool");
  });

  it("includes the firecrawl section for contextUrl scraping", () => {
    const prompt = buildLincolnSystemPrompt("Lincoln");
    expect(prompt).toContain("<firecrawl>");
    expect(prompt).toContain("contextUrls");
    expect(prompt).toContain("firecrawl");
  });

  it("includes the output section, gated on artifact_link_file, not a file-write tool", () => {
    const prompt = buildLincolnSystemPrompt("Lincoln");
    expect(prompt).toContain("<output>");
    expect(prompt).toContain("artifact_link_file");
  });

  it("does not instruct any retired posix runner tool", () => {
    const prompt = buildLincolnSystemPrompt("Lincoln");
    for (const retired of [
      "read_file",
      "write_file",
      "edit_file",
      "search_files",
      "run_shell",
      "grep",
    ]) {
      expect(prompt).not.toContain(retired);
    }
  });
});
