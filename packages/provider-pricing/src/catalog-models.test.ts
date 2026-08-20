import { catalogModels } from "@intx/inference-catalog/models";
import { describe, expect, test } from "bun:test";

import { CATALOG_MODEL_NAMES } from "./catalog-models";

describe("CATALOG_MODEL_NAMES", () => {
  test("matches @intx/inference-catalog's catalogModels exactly", () => {
    const fromCatalog = new Set(catalogModels.map((m) => m.canonicalName));
    const hardListed = new Set(CATALOG_MODEL_NAMES);
    expect(hardListed.size).toBe(CATALOG_MODEL_NAMES.length);
    expect([...fromCatalog].sort()).toEqual([...hardListed].sort());
  });
});
