import { describe, expect, test } from "bun:test";
import {
  deriveBareToolDescriptions,
  loadCommittedToolManifestFactories,
  writeBareToolNamesFromFactories,
} from "./index";

describe("writeBareToolNamesFromFactories", () => {
  test("includes linear writes from the committed index", () => {
    const writes = writeBareToolNamesFromFactories(
      loadCommittedToolManifestFactories(),
    );
    expect(writes).toContain("linear_create_issue");
    expect(writes).toContain("linear_update_issue");
    expect(writes).not.toContain("linear_list_issues");
  });
});

describe("deriveBareToolDescriptions", () => {
  test("exposes the real manifest description per package tool from the committed index", () => {
    const byPackage = deriveBareToolDescriptions(
      loadCommittedToolManifestFactories(),
    );
    const linear = byPackage["@workbench/tools-linear"];
    expect(linear).toBeDefined();
    const desc = linear?.["linear_list_issues"];
    expect(typeof desc).toBe("string");
    expect((desc ?? "").length).toBeGreaterThan(0);
  });
});
