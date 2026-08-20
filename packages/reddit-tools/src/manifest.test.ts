// Proves this package's own `package.json` satisfies the vendored
// `PackageJSON` manifest schema (`@intx/types/src/package-json.ts`)
// with an `interchange.credentials` declaration the deploy-time
// `ToolPackageManifest` harvests into `topLevel[].credentials` — the
// static half of the credential-binding seam CL-6028 adopts. Not a test
// of the vendored schema itself, only that this package's manifest is
// shaped the way that schema requires.
import { expect, test } from "bun:test";
import { type } from "arktype";
import { PackageJSON } from "@intx/types/package-json";

import packageJson from "../package.json";

test("package.json parses against the vendored PackageJSON manifest schema", () => {
  const parsed = PackageJSON(packageJson);
  expect(parsed instanceof type.errors).toBe(false);
});

test("declares exactly one credential handle: scrapecreators", () => {
  const parsed = PackageJSON(packageJson);
  if (parsed instanceof type.errors) {
    throw new Error(parsed.summary);
  }
  expect(parsed.interchange?.credentials).toEqual([
    { handle: "scrapecreators" },
  ]);
});
