import { describe, expect, test } from "bun:test";
import { MYRA_TOOL_CATALOG } from "@workbench/agent-core";
import { sanitizeMemberMyraToolDisables } from "./myra-member-tool-settings";

describe("sanitizeMemberMyraToolDisables", () => {
  const catalog = MYRA_TOOL_CATALOG.slice(0, 2);

  test("drops unknown package and tool ids", () => {
    const out = sanitizeMemberMyraToolDisables(
      catalog,
      ["not-a-package", catalog[0]!.package],
      ["fake__tool"],
    );
    expect(out.disabledCatalogPackages).toEqual([catalog[0]!.package]);
    expect(out.disabledToolNames).toEqual([]);
  });
});
