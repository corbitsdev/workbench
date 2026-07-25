// a tool package's manifest declares `packageName` by hand
// (`manifestFromHubToolEntries({ packageName: ... })`); nothing enforced
// that it actually equals the owning package's real `package.json#name` on
// disk — the name `build-tool-packages.ts` tarballs. Every affected workflow
// package's manifest claimed a `@workbench/tools-<x>` packageName while its
// own `package.json#name` was `@workbench/workflow-<x>`, so the pin derived
// from the manifest's factory id never matched anything ever published
// (`tarball.missing` at deploy-apply time). This walks the real, current
// checkout (the same discovery walk `build-tool-manifests.ts` uses) and
// dynamically imports each package's real manifest file, so it fails the
// moment a manifest's `packageName` drifts from disk again.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "bun:test";
import { discoverToolPackageDirs } from "./discover";
import { parseToolManifestFile } from "./schema";

function repoRoot(): string {
  // packages/tool-manifest/src -> repo root is three levels up.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

const root = repoRoot();
const relativeDirs = discoverToolPackageDirs(root);

describe("tool package manifest packageName matches package.json#name on disk", () => {
  it("discovered at least one tool package", () => {
    expect(relativeDirs.length).toBeGreaterThan(0);
  });

  for (const rel of relativeDirs) {
    it(`${rel}: every factory's packageName equals package.json#name`, async () => {
      const packageDir = join(root, rel);
      const pkgJsonPath = join(packageDir, "package.json");
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
        name?: unknown;
        interchange?: { manifest?: string };
      };
      expect(typeof pkgJson.name).toBe("string");
      const packageName = pkgJson.name as string;

      const manifestRel = pkgJson.interchange?.manifest;
      expect(typeof manifestRel).toBe("string");
      const manifestPath = join(packageDir, manifestRel as string);
      expect(existsSync(manifestPath)).toBe(true);

      const mod = (await import(pathToFileURL(manifestPath).href)) as {
        toolManifestFile?: unknown;
        default?: unknown;
      };
      const parsed = parseToolManifestFile(mod.toolManifestFile ?? mod.default);
      expect(typeof parsed).not.toBe("string");
      if (typeof parsed === "string") return;

      for (const factory of parsed.factories) {
        expect(factory.packageName).toBe(packageName);
      }
    });
  }
});
