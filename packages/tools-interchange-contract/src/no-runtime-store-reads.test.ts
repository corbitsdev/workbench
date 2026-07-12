import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * apps/sidecar/src/agent-tools.ts memoizes loadManifest results across
 * instance launches. A tool factory closure created for one instance can
 * therefore outlive the per-instance store directory it was imported from
 * and get reused for a later instance whose store directory is different
 * (or already gone). Any factory that resolves paths relative to its own
 * module location (`__dirname`, `import.meta.url`/`import.meta.dir`) and
 * reads the filesystem at call time will silently read the wrong
 * instance's files, or a directory that no longer exists.
 *
 * This test statically scans every tool package's src directory (packages
 * named "tools-*") for those patterns so a future tool package cannot reintroduce a
 * store-relative runtime read. Nothing is allow-listed today; if a
 * legitimate import-time (not call-time) use is ever needed, add it to
 * ALLOWED_EXCEPTIONS below with a comment explaining why it is safe.
 */

const PACKAGES_ROOT = join(import.meta.dir, "..", "..");

const FORBIDDEN_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "__dirname", pattern: /__dirname/ },
  { name: "__filename", pattern: /__filename/ },
  { name: "import.meta.dir", pattern: /import\.meta\.dir/ },
  { name: "import.meta.url", pattern: /import\.meta\.url/ },
];

const ALLOWED_EXCEPTIONS: Record<string, string[]> = {};

// This contract package itself is excluded: it is test-only infrastructure
// (no runtime tool factories, no manifest entry) and its own source
// necessarily names the patterns it scans for.
const SELF_PACKAGE = "tools-interchange-contract";

function collectToolPackageDirs(): string[] {
  return readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith("tools-") &&
        entry.name !== SELF_PACKAGE,
    )
    .map((entry) => join(PACKAGES_ROOT, entry.name, "src"));
}

function collectSourceFiles(dir: string): string[] {
  let files: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(collectSourceFiles(fullPath));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("tool packages never read their store directory at runtime", () => {
  const toolSrcDirs = collectToolPackageDirs();
  expect(toolSrcDirs.length).toBeGreaterThan(0);

  for (const srcDir of toolSrcDirs) {
    const packageName = relative(PACKAGES_ROOT, join(srcDir, ".."));
    const files = collectSourceFiles(srcDir);

    for (const file of files) {
      const relPath = relative(PACKAGES_ROOT, file);
      const exceptions = ALLOWED_EXCEPTIONS[relPath] ?? [];

      test(`${relPath} does not resolve paths from its own module location`, () => {
        const content = readFileSync(file, "utf8");
        const violations = FORBIDDEN_PATTERNS.filter(
          ({ name, pattern }) =>
            pattern.test(content) && !exceptions.includes(name),
        );

        expect(
          violations,
          `${relPath} (package ${packageName}) uses module-relative path resolution ` +
            `(${violations.map((v) => v.name).join(", ")}). ` +
            "apps/sidecar/src/agent-tools.ts caches loadManifest results across instance " +
            "launches, so a tool factory closure can outlive the per-instance store directory " +
            "it was imported from. Tool packages must never read files relative to their own " +
            "module location at call time — read from paths passed in via the factory's env/args " +
            "instead. If this use is genuinely import-time and safe, add it to ALLOWED_EXCEPTIONS " +
            "in this test with a comment explaining why.",
        ).toEqual([]);
      });
    }
  }
});
