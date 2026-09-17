// Proves this package's own `package.json` satisfies the vendored
// `PackageJSON` manifest schema (`@intx/types/src/package-json.ts`)
// with an `interchange.credentials` declaration the deploy-time
// `ToolPackageManifest` harvests into `topLevel[].credentials` — the
// static half of the credential-binding seam CL-6028 adopts. GitHub's
// credential is optional at runtime (an unresolved "github" handle
// degrades to unauthenticated calls, never "not connected" — see
// `tool.ts`), but the manifest still declares the handle that *could*
// be bound, same as the registry's `github` connector entry existing at
// all.
import { expect, test } from "bun:test";
import { type } from "arktype";
import { PackageJSON } from "@intx/types/package-json";

import packageJson from "../package.json";

test("package.json parses against the vendored PackageJSON manifest schema", () => {
  const parsed = PackageJSON(packageJson);
  expect(parsed instanceof type.errors).toBe(false);
});

test("declares exactly one credential handle: github", () => {
  const parsed = PackageJSON(packageJson);
  if (parsed instanceof type.errors) {
    throw new Error(parsed.summary);
  }
  expect(parsed.interchange?.credentials).toEqual([{ handle: "github" }]);
});
