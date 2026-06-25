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

  it("includes the memory section instructing state/memory.md usage", () => {
    const prompt = buildLincolnSystemPrompt("Lincoln");
    expect(prompt).toContain("<memory>");
    expect(prompt).toContain("state/memory.md");
  });

  it("includes the firecrawl section for contextUrl scraping", () => {
    const prompt = buildLincolnSystemPrompt("Lincoln");
    expect(prompt).toContain("<firecrawl>");
    expect(prompt).toContain("contextUrls");
    expect(prompt).toContain("firecrawl");
  });

  it("includes the output section with write_file and artifact_link_file instructions", () => {
    const prompt = buildLincolnSystemPrompt("Lincoln");
    expect(prompt).toContain("<output>");
    expect(prompt).toContain("write_file");
    expect(prompt).toContain("artifact_link_file");
  });
});
