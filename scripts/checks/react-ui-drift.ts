// check:react-ui-drift — a ratchet, not a cliff edge. Wave 2 (CL-6068) cut
// most hand-rolled DOM over to `@corbits/react-ui` primitives, but a handful
// of sites are deliberately left raw for a later wave; this check keeps the
// total from creeping back up while those sites get burned down over time.
//
// Four violation classes, scanned across every non-test `.tsx` file under
// apps/, packages/, and workflows/ (excluding node_modules, dist,
// .worktrees, and `*.test.tsx` — a test asserting on
// `[role="dialog"]` markup or a string like `"<table"` is not itself a
// drift site, the same reasoning check:ui-vocabulary uses to skip tests):
//
//   a. raw `<select`, `<textarea`, `type="radio"`, `type="checkbox"` —
//      react-ui ships Select-shaped and Textarea-shaped primitives. Files
//      named in the allowlist are excluded from this count entirely (their
//      raw controls are a known, ticketed wave-3+ cleanup, not new drift).
//   b. raw `<table` — react-ui ships `ui/table` and `ui/csv-table`. No
//      allowlist exclusion: every raw table counts.
//   c. raw `role="dialog"` or `aria-modal` — react-ui's `Dialog` owns this
//      wiring. Zero legitimate sites exist today, so this is a hard,
//      non-ratcheting gate: any hit fails the check outright, allowlist or
//      snapshot notwithstanding.
//   d. raw `<button` carrying a `className` prop, in a file that imports no
//      Button-like export from `@corbits/react-ui` (a real DOM button is
//      fine on its own — `type="button"` with no styling hook rides on
//      inherited/global chrome — it is the *paired* raw-button-plus-custom-
//      class combination this class is after). Allowlisted files are
//      excluded from this count, same reasoning as (a).
//
// Mode: ratchet. The check sums (a excluding allowlisted files) + (b, all
// files) + (d excluding allowlisted files) and fails only when that total
// exceeds `REACT_UI_DRIFT_SNAPSHOT` from react-ui-drift-allowlist.ts — i.e.
// only on *new* drift. Existing allowlisted sites and the frozen snapshot
// total are the accepted baseline, not a clean bill of health.
import { Glob } from "bun";
import path from "node:path";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";
import {
  REACT_UI_DRIFT_ALLOWLIST,
  REACT_UI_DRIFT_SNAPSHOT,
  type DriftAllowlistEntry,
} from "./react-ui-drift-allowlist";

const SCAN_DIRS = ["apps", "packages", "workflows"];

const EXCLUDED_SEGMENTS = [
  "node_modules",
  "dist",
  ".worktrees",
  "scripts/checks/test",
];

export interface ScannedFile {
  relPath: string;
  contents: string;
}

export type DriftClass =
  "raw-form-control" | "raw-table" | "raw-modal-attr" | "raw-button";

export interface DriftViolation {
  relPath: string;
  line: number;
  driftClass: DriftClass;
  snippet: string;
}

const RAW_FORM_CONTROL_PATTERN =
  /<select\b|<textarea\b|type=["']radio["']|type=["']checkbox["']/g;

const RAW_TABLE_PATTERN = /<table\b/g;

const RAW_MODAL_ATTR_PATTERN = /role=["']dialog["']|\baria-modal\b/g;

/** Matches one JSX opening tag, e.g. `<button ... >` or a self-closing
 * `<button ... />`. Doesn't cross a `>` that isn't part of an attribute
 * value — good enough for the button shapes this codebase actually
 * writes; it isn't a JSX parser. */
const BUTTON_OPEN_TAG_PATTERN = /<button\b[^>]*>/g;

const REACT_UI_IMPORT_PATTERN =
  /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']@corbits\/react-ui(?:\/[^"']*)?["']/g;

function lineNumberAt(contents: string, index: number): number {
  return contents.slice(0, index).split("\n").length;
}

function snippetAt(
  contents: string,
  index: number,
  matchLength: number,
): string {
  const lines = contents.split("\n");
  const line = lineNumberAt(contents, index);
  return (lines[line - 1] ?? contents.slice(index, index + matchLength)).trim();
}

/** True when the file imports any export from `@corbits/react-ui` whose
 * name contains "Button" — `Button` itself, but also `ConfirmButton`,
 * `RunNowButton`, and any future Button-shaped primitive. */
function importsButtonLike(contents: string): boolean {
  for (const match of contents.matchAll(REACT_UI_IMPORT_PATTERN)) {
    const specifiers = match[1] ?? "";
    for (const specifier of specifiers.split(",")) {
      const name = specifier
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name !== undefined && /Button/.test(name)) return true;
    }
  }
  return false;
}

function findMatches(
  pattern: RegExp,
  contents: string,
  relPath: string,
  driftClass: DriftClass,
): DriftViolation[] {
  const violations: DriftViolation[] = [];
  for (const match of contents.matchAll(pattern)) {
    if (match.index === undefined) continue;
    violations.push({
      relPath,
      line: lineNumberAt(contents, match.index),
      driftClass,
      snippet: snippetAt(contents, match.index, match[0].length),
    });
  }
  return violations;
}

function findRawButtonViolations(
  contents: string,
  relPath: string,
): DriftViolation[] {
  if (importsButtonLike(contents)) return [];
  const violations: DriftViolation[] = [];
  for (const match of contents.matchAll(BUTTON_OPEN_TAG_PATTERN)) {
    if (match.index === undefined) continue;
    if (!/\bclassName=/.test(match[0])) continue;
    violations.push({
      relPath,
      line: lineNumberAt(contents, match.index),
      driftClass: "raw-button",
      snippet: snippetAt(contents, match.index, match[0].length),
    });
  }
  return violations;
}

/**
 * Every violation found, tagged with whether it counts toward the ratchet
 * total — (a) and (d) hits in an allowlisted file are excluded from the
 * count (they're known, ticketed drift) but still returned so callers can
 * see the full picture.
 */
export function findDriftViolations(
  files: readonly ScannedFile[],
): readonly DriftViolation[] {
  const violations: DriftViolation[] = [];
  for (const { relPath, contents } of files) {
    violations.push(
      ...findMatches(
        RAW_FORM_CONTROL_PATTERN,
        contents,
        relPath,
        "raw-form-control",
      ),
      ...findMatches(RAW_TABLE_PATTERN, contents, relPath, "raw-table"),
      ...findMatches(
        RAW_MODAL_ATTR_PATTERN,
        contents,
        relPath,
        "raw-modal-attr",
      ),
      ...findRawButtonViolations(contents, relPath),
    );
  }
  return violations;
}

/** Whether a violation counts toward the ratcheted total — everything
 * except (a)/(d) hits inside an allowlisted file, and excluding (c)
 * entirely since that class is scored separately as a hard gate. */
function countsTowardRatchet(
  violation: DriftViolation,
  allowlistPaths: ReadonlySet<string>,
): boolean {
  if (violation.driftClass === "raw-modal-attr") return false;
  if (violation.driftClass === "raw-table") return true;
  return !allowlistPaths.has(violation.relPath);
}

export interface DriftAudit {
  readonly report: CheckReport;
  readonly ratchetCount: number;
}

export function auditReactUiDrift(
  files: readonly ScannedFile[],
  allowlist: readonly DriftAllowlistEntry[] = REACT_UI_DRIFT_ALLOWLIST,
  snapshot: number = REACT_UI_DRIFT_SNAPSHOT,
): DriftAudit {
  const allowlistPaths = new Set(allowlist.map((entry) => entry.relPath));
  const report = emptyReport();
  const violations = findDriftViolations(files);

  const hardFails = violations.filter((v) => v.driftClass === "raw-modal-attr");
  for (const violation of hardFails) {
    report.violations.push(
      `${violation.relPath}:${violation.line}: raw role="dialog"/aria-modal ` +
        `is a zero-tolerance violation — use react-ui's Dialog — ${violation.snippet}`,
    );
  }

  const ratcheted = violations.filter((v) =>
    countsTowardRatchet(v, allowlistPaths),
  );
  const ratchetCount = ratcheted.length;

  if (ratchetCount > snapshot) {
    for (const violation of ratcheted) {
      report.violations.push(
        `${violation.relPath}:${violation.line}: ${violation.driftClass} — ${violation.snippet}`,
      );
    }
    report.violations.push(
      `total drift count ${ratchetCount} exceeds the recorded snapshot ` +
        `${snapshot} — new raw DOM was introduced where a react-ui ` +
        "primitive exists; cut it over or, if it's genuinely out of " +
        "scope, add a ticketed allowlist entry and account for it in " +
        "the snapshot",
    );
  }

  report.notes.push(
    `${ratchetCount} drift site(s) counted against a snapshot of ${snapshot}`,
  );
  return { report, ratchetCount };
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
    const glob = new Glob("**/*.tsx");
    for await (const file of glob.scan({ cwd: path.join(root, dir) })) {
      if (file.endsWith(".test.tsx")) continue;
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
  const { report } = auditReactUiDrift(files);
  report.notes.push(
    `scanned ${files.length} .tsx file(s) under ${SCAN_DIRS.join(", ")}`,
  );
  reportAndExit("check:react-ui-drift", report);
}

if (import.meta.main) await main();
