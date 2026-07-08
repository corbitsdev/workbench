import { describe, expect, test } from "bun:test";
import { modelsDevProviderIdsForCatalogProvider } from "./models-dev";

describe("modelsDevProviderIdsForCatalogProvider", () => {
  test("maps opencode-zen to models.dev opencode", () => {
    expect(modelsDevProviderIdsForCatalogProvider("opencode-zen")).toEqual([
      "opencode",
    ]);
  });

  test("returns empty when the catalog provider has no models.dev id", () => {
    expect(modelsDevProviderIdsForCatalogProvider("anthropic-api")).toEqual([]);
    expect(modelsDevProviderIdsForCatalogProvider("unknown")).toEqual([]);
  });
});
