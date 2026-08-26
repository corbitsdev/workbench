// Proves this package's own `package.json` satisfies the vendored
// `PackageJSON` manifest schema with an `interchange.credentials`
// declaration the deploy-time `ToolPackageManifest` harvests.
import { expect, test } from "bun:test";
import { type } from "arktype";
import { PackageJSON } from "@intx/types/package-json";

import packageJson from "../package.json";

test("package.json parses against the vendored PackageJSON manifest schema", () => {
  const parsed = PackageJSON(packageJson);
  expect(parsed instanceof type.errors).toBe(false);
});

test("declares exactly one credential handle: manus", () => {
  const parsed = PackageJSON(packageJson);
  if (parsed instanceof type.errors) {
    throw new Error(parsed.summary);
  }
  expect(parsed.interchange?.credentials).toEqual([{ handle: "manus" }]);
  expect(parsed.version).toBe("0.0.1");
});
