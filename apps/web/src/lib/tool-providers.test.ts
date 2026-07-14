import { describe, expect, it } from "bun:test";
import {
  providerKeyForToolLogo,
  providerLabel,
  providerLogoFile,
  toolProviderLogoFilename,
} from "./tool-providers";

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

describe("toolProviderLogoFilename", () => {
  it("resolves linear and attio marks from LLM wire names", () => {
    expect(toolProviderLogoFilename("linear__get_issue")).toBe("linear.svg");
    expect(toolProviderLogoFilename("attio__create_record")).toBe(
      "attio-dark.svg",
    );
  });

  it("resolves bare integration op ids when the wire name has no prefix", () => {
    expect(providerKeyForToolLogo("exa_search")).toBe("exa");
    expect(toolProviderLogoFilename("exa_search")).toBe("exa-dark.svg");
  });

  it("returns null when the call is not attributable", () => {
    expect(toolProviderLogoFilename("read_file")).toBeNull();
    expect(toolProviderLogoFilename("totally_unknown__thing")).toBeNull();
  });
});

describe("providerLabel", () => {
  it("uses the curated label, humanizing unknown keys", () => {
    expect(providerLabel("firecrawl")).toBe("Firecrawl");
    expect(providerLabel("some_new_provider")).toBe("Some new provider");
  });
});
