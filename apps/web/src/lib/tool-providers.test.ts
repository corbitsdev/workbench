import { describe, expect, it } from "bun:test";
import { providerLabel, providerLogoFile } from "./tool-providers";

describe("providerLogoFile", () => {
  it("maps known providers to a brands-library filename", () => {
    expect(providerLogoFile("firecrawl")).toBe("firecrawl.svg");
    expect(providerLogoFile("exa")).toBe("exa-dark.svg");
  });

  it("is case-insensitive on the provider key", () => {
    expect(providerLogoFile("Firecrawl")).toBe("firecrawl.svg");
    expect(providerLogoFile("ATTIO")).toBe("attio-dark.svg");
  });

  it("surfaces Reddit's mark for scrapecreators-backed Reddit tools", () => {
    expect(providerLogoFile("scrapecreators")).toBe("reddit.svg");
    expect(providerLogoFile("reddit")).toBe("reddit.svg");
  });

  it("returns null for a provider we have no mark for", () => {
    expect(providerLogoFile("totally-unknown")).toBeNull();
  });
});

describe("providerLabel", () => {
  it("uses the curated label, humanizing unknown keys", () => {
    expect(providerLabel("firecrawl")).toBe("Firecrawl");
    expect(providerLabel("some_new_provider")).toBe("Some new provider");
  });
});
