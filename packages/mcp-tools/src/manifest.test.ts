// Proves this package's own `package.json` satisfies the vendored
// `PackageJSON` manifest schema (`@intx/types/src/package-json.ts`)
// and, unlike `@corbits/web-search-tools`, declares no static
// `interchange.credentials` entries — see `tool.ts`'s header comment for
// why an MCP server's `mcp.<slug>` handle can't be pre-declared.
import { expect, test } from "bun:test";
import { type } from "arktype";
import { PackageJSON } from "@intx/types/package-json";

import packageJson from "../package.json";

test("package.json parses against the vendored PackageJSON manifest schema", () => {
  const parsed = PackageJSON(packageJson);
  expect(parsed instanceof type.errors).toBe(false);
});

test("declares no static credential handles (MCP server handles are dynamic)", () => {
  const parsed = PackageJSON(packageJson);
  if (parsed instanceof type.errors) {
    throw new Error(parsed.summary);
  }
  expect(parsed.interchange?.credentials).toBeUndefined();
});
