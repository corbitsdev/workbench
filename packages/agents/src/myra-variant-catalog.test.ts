import { describe, expect, it } from "bun:test";
import { FULL_CATALOG } from "@workbench/catalog";
import { MYRA_VARIANTS } from "@workbench/myra";

describe("every Myra variant model is launchable via the catalog", () => {
  it("has at least one FULL_CATALOG offering for every variant model", () => {
    const offered = new Set(FULL_CATALOG.offerings.map((o) => o.model));
    for (const variant of MYRA_VARIANTS) {
      expect(offered.has(variant.model)).toBe(true);
    }
  });
});
