// check:tool-package-pins — a workflow's `{ name, version }` tool-package
// pin literal must match that package's own package.json version.
//
// Tool resolution keys on `name@version`, and every pin is hand-maintained
// (CL-6437): nothing ripples a version bump to the workflows that pin it.
// PR #165 bumped `@corbits/connections-tools` to 0.0.5 and left
// `workflows/assistant/src/index.ts` pinning 0.0.4, breaking that
// workflow's deploy; the same drift hit `@corbits/mcp-tools` during
// CL-6456. Nothing caught either at merge time. This check is the static,
// cheap half of that class (CL-6497): every `{ name: "@corbits/x",
// version: "y" }` literal anywhere in the tree must name the version its
// package.json actually carries, or the pin resolves to a version the
// registry never publishes and every deploy that pins it fails.
//
// It does not (and, in this idiom, practically cannot) catch the other
// half of the class — a package whose `src/` changed without a version
// bump — since that needs the PR's git history (a merge-base diff), not
// a snapshot of the working tree; see CL-6497's PR description for why
// that half is out of scope here.
import { Glob } from "bun";
import path from "node:path";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

const SCAN_DIRS = ["apps", "packages", "tools", "workflows"];

const EXCLUDED_SEGMENTS = ["node_modules", "dist", ".worktrees", "vendor"];

// Matches a pin object literal in the shape every pin site in this repo
// uses today: `name` first, then `version`, both string literals, an
// optional trailing comma before the closing brace. `\s` already spans
// newlines, so the multi-line form (`SKILLS_TOOL_PACKAGE_PIN`) matches
// the same as the single-line array-entry form.
const PIN_PATTERN =
  /\{\s*name:\s*"(@corbits\/[a-z0-9-]+)"\s*,\s*version:\s*"([^"]*)"\s*,?\s*\}/g;

export interface PinReference {
  readonly relPath: string;
  readonly line: number;
  readonly name: string;
  readonly version: string;
}

export interface ScannedFile {
  readonly relPath: string;
  readonly contents: string;
}

function lineNumberAt(contents: string, index: number): number {
  return contents.slice(0, index).split("\n").length;
}

/** Every `{ name: "@corbits/x", version: "y" }` pin literal in a file. */
export function extractPins(relPath: string, contents: string): PinReference[] {
  const pins: PinReference[] = [];
  for (const match of contents.matchAll(PIN_PATTERN)) {
    if (match.index === undefined) continue;
    const [, name, version] = match;
    if (name === undefined || version === undefined) continue;
    pins.push({
      relPath,
      line: lineNumberAt(contents, match.index),
      name,
      version,
    });
  }
  return pins;
}

/**
 * Every pin must name a version equal to its package's own manifest
 * version. A pin naming a package with no workspace manifest at all is
 * also a violation — that pin can never resolve, whatever version it
 * names.
 */
export function auditToolPackagePins(
  pins: readonly PinReference[],
  manifestVersions: ReadonlyMap<string, string>,
): CheckReport {
  const report = emptyReport();
  for (const pin of [...pins].sort(
    (a, b) => a.relPath.localeCompare(b.relPath) || a.line - b.line,
  )) {
    const manifestVersion = manifestVersions.get(pin.name);
    if (manifestVersion === undefined) {
      report.violations.push(
        `${pin.relPath}:${pin.line}: pins "${pin.name}" but no workspace ` +
          `package publishes that name — this pin can never resolve.`,
      );
      continue;
    }
    if (manifestVersion === pin.version) continue;
    report.violations.push(
      `${pin.relPath}:${pin.line}: pins ${pin.name}@${pin.version} but ` +
        `its package.json is at ${manifestVersion} — update the pin to ` +
        `"${manifestVersion}" (or, if the manifest is the one that's ` +
        `behind, bump the package in the same commit).`,
    );
  }
  return report;
}

async function manifestVersions(root: string): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  const glob = new Glob("{apps,packages,tools,workflows}/*/package.json");
  for await (const relPath of glob.scan(root)) {
    if (relPath.includes("node_modules/")) continue;
    const manifest = (await Bun.file(path.join(root, relPath)).json()) as {
      name?: string;
      version?: string;
    };
    if (manifest.name === undefined || manifest.version === undefined) {
      continue;
    }
    versions.set(manifest.name, manifest.version);
  }
  return versions;
}

function isExcludedPath(relPath: string): boolean {
  return EXCLUDED_SEGMENTS.some(
    (segment) =>
      relPath === segment ||
      relPath.startsWith(`${segment}/`) ||
      relPath.includes(`/${segment}/`),
  );
}

async function scanFiles(
  root: string,
  dirs: readonly string[],
): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  for (const dir of dirs) {
    const glob = new Glob("**/*.ts");
    for await (const file of glob.scan({ cwd: path.join(root, dir) })) {
      if (file.endsWith(".test.ts")) continue;
      const relPath = path.join(dir, file);
      if (isExcludedPath(relPath)) continue;
      files.push({
        relPath,
        contents: await Bun.file(path.join(root, relPath)).text(),
      });
    }
  }
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function main(): Promise<void> {
  const root = rootFromArgs(Bun.argv.slice(2));
  const files = await scanFiles(root, SCAN_DIRS);
  const pins = files.flatMap((file) =>
    extractPins(file.relPath, file.contents),
  );
  const versions = await manifestVersions(root);
  const report = auditToolPackagePins(pins, versions);
  report.notes.push(
    `${pins.length} pin(s) found across ${files.length} file(s) under ${SCAN_DIRS.join(", ")}`,
  );
  reportAndExit("check:tool-package-pins", report);
}

if (import.meta.main) await main();
