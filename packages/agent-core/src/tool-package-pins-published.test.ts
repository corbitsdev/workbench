/// <reference types="bun" />
// CL-4454: `toolPackagesForCapabilities` derives a deploy's toolPackagePins
// from a factory id (`@scope/pkg-name/segment` -> `@scope/pkg-name`), but
// nothing enforced that the derived name is a package that was ever actually
// published. A workflow package's real npm name
// (`package.json#name`, what `build-tool-packages.ts` tarballs) can drift
// from the factory id its own manifest declares, producing a pin the
// package-registry resolver 404s on (`tarball.missing`) at deploy-apply
// time — invisible to typecheck/lint/unit tests because nothing cross-checks
// the derived pin against the committed, built manifest. This test reads the
// real built manifest from disk so it fails the moment that drift recurs.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { PACKAGE_TOOLS_TABLE, toolPackagesForCapabilities } from "./tool-names";

function repoRoot(): string {
  // packages/agent-core/src -> repo root is three levels up.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function loadPublishedToolPackageNames(): Set<string> {
  const manifestPath = join(
    repoRoot(),
    "apps",
    "hub",
    "generated",
    "tool-packages",
    "manifest.json",
  );
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    name: string;
  }[];
  return new Set(raw.map((entry) => entry.name));
}

describe("toolPackagesForCapabilities pins resolve to published tarballs (CL-4454)", () => {
  const publishedNames = loadPublishedToolPackageNames();

  it("has at least one published tool package to check against", () => {
    expect(publishedNames.size).toBeGreaterThan(0);
  });

  for (const factoryId of Object.keys(PACKAGE_TOOLS_TABLE)) {
    const [bareName] = PACKAGE_TOOLS_TABLE[factoryId] ?? [];
    if (bareName === undefined) continue;

    it(`${factoryId}: derived pin exists in apps/hub/generated/tool-packages/manifest.json`, () => {
      const [pin] = toolPackagesForCapabilities([`${factoryId}:${bareName}`]);
      expect(pin).toBeDefined();
      expect(publishedNames.has(pin!.name)).toBe(true);
    });
  }
});
