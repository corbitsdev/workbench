// Proves this package's own `package.json` satisfies the vendored
// `PackageJSON` manifest schema (`@intx/types/src/package-json.ts`) with
// an `interchange.credentials` declaration the deploy-time
// `ToolPackageManifest` harvests into `topLevel[].credentials`.
import { expect, test } from "bun:test";
import { type } from "arktype";
import { PackageJSON } from "@intx/types/package-json";

import packageJson from "../package.json";

test("package.json parses against the vendored PackageJSON manifest schema", () => {
  const parsed = PackageJSON(packageJson);
  expect(parsed instanceof type.errors).toBe(false);
});

test("declares exactly one credential handle: gotenberg", () => {
  const parsed = PackageJSON(packageJson);
  if (parsed instanceof type.errors) {
    throw new Error(parsed.summary);
  }
  expect(parsed.interchange?.credentials).toEqual([{ handle: "gotenberg" }]);
});
