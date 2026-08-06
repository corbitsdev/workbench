// check:killdates — kill dates for temporary paths.
//
// scripts/checks/kill-dates.txt registers every temporary path with an
// owner and a kill date; this check fails once the date has passed
// while the path still exists, and fails on stale rows whose path is
// already gone. Vendored code (see VENDORED.md) and short-lived
// bridges register here in the same change that introduces them.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";
import { hashDirectory } from "./lib/tree-hash";

export const REGISTRY_PATH = "scripts/checks/kill-dates.txt";

export interface KillDateEntry {
  /** Repo-relative path of the temporary code. */
  path: string;
  owner: string;
  /** ISO date (YYYY-MM-DD) after which the path may no longer exist. */
  killDate: string;
  /** sha256 of the directory tree as recorded (vendored rows only). */
  hash?: string;
}

export interface ParsedKillDates {
  entries: KillDateEntry[];
  problems: string[];
}

/**
 * Rows are `path | owner | YYYY-MM-DD` with an optional trailing
 * `| sha256` column; `#` comments and blanks ignored.
 */
export function parseKillDates(text: string): ParsedKillDates {
  const parsed: ParsedKillDates = { entries: [], problems: [] };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const columns = line.split("|").map((column) => column.trim());
    const [entryPath, owner, killDate, hash] = columns;
    if (
      columns.length < 3 ||
      columns.length > 4 ||
      entryPath === undefined ||
      entryPath.length === 0 ||
      owner === undefined ||
      owner.length === 0 ||
      killDate === undefined
    ) {
      parsed.problems.push(
        `malformed row "${line}" — expected "path | owner | YYYY-MM-DD".`,
      );
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(killDate)) {
      parsed.problems.push(
        `row "${line}" has kill date "${killDate}" — expected YYYY-MM-DD.`,
      );
      continue;
    }
    const entry: KillDateEntry = { path: entryPath, owner, killDate };
    if (hash !== undefined) entry.hash = hash;
    parsed.entries.push(entry);
  }
  return parsed;
}

/** Repo-relative paths of every directory two levels under vendor/. */
export function listVendoredPaths(root: string): string[] {
  const vendorRoot = path.join(root, "vendor");
  if (!existsSync(vendorRoot)) return [];
  const vendored: string[] = [];
  for (const bucket of readdirSync(vendorRoot, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue;
    const bucketPath = path.join(vendorRoot, bucket.name);
    for (const entry of readdirSync(bucketPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      vendored.push(path.join("vendor", bucket.name, entry.name));
    }
  }
  return vendored.sort();
}

/** Every vendored directory must carry a kill-date registry row. */
export function auditVendorCoverage(
  vendoredPaths: readonly string[],
  entries: readonly KillDateEntry[],
): CheckReport {
  const report = emptyReport();
  const registered = new Set(entries.map((entry) => entry.path));
  for (const vendoredPath of vendoredPaths) {
    if (registered.has(vendoredPath)) continue;
    report.violations.push(
      `${vendoredPath}: vendored directory with no row in ` +
        `${REGISTRY_PATH} — every vendored path registers a kill date ` +
        `in the same change that introduces it (see VENDORED.md).`,
    );
  }
  return report;
}

/** Every existing vendored row's recorded hash must match its tree. */
export function auditVendorDrift(
  entries: readonly KillDateEntry[],
  root: string,
): CheckReport {
  const report = emptyReport();
  for (const entry of entries) {
    if (!entry.path.startsWith("vendor/")) continue;
    const dir = path.join(root, entry.path);
    if (!existsSync(dir)) continue;
    if (entry.hash === undefined || !/^[0-9a-f]{64}$/.test(entry.hash)) {
      report.violations.push(
        `${entry.path}: registry row is missing a valid sha256 content ` +
          `hash column — record hashDirectory() of the vendored tree in ` +
          `${REGISTRY_PATH}.`,
      );
      continue;
    }
    if (hashDirectory(dir) !== entry.hash) {
      report.violations.push(
        `${entry.path}: vendored tree edited without recording it — ` +
          `update the hash in ${REGISTRY_PATH} and the package's ` +
          `VENDORED-FROM delta line.`,
      );
    }
  }
  return report;
}

export function auditKillDates(
  entries: readonly KillDateEntry[],
  today: string,
  exists: (repoRelativePath: string) => boolean,
): CheckReport {
  const report = emptyReport();
  for (const entry of entries) {
    if (!exists(entry.path)) {
      report.violations.push(
        `${entry.path}: registered in ${REGISTRY_PATH} but no longer ` +
          `exists — remove the stale row (owner: ${entry.owner}).`,
      );
      continue;
    }
    if (today > entry.killDate) {
      report.violations.push(
        `${entry.path}: kill date ${entry.killDate} has passed and the ` +
          `path still exists (owner: ${entry.owner}). Replace it with ` +
          `the permanent implementation and delete it, or deliberately ` +
          `renew the date through review — and update VENDORED.md if ` +
          `the path is vendored.`,
      );
      continue;
    }
    report.notes.push(
      `${entry.path} is temporary until ${entry.killDate} ` +
        `(owner: ${entry.owner}).`,
    );
  }
  return report;
}

function main(): void {
  const root = rootFromArgs(Bun.argv.slice(2));
  const registryFile = path.join(root, REGISTRY_PATH);
  const parsed = existsSync(registryFile)
    ? parseKillDates(readFileSync(registryFile, "utf8"))
    : { entries: [], problems: [] };
  const today = new Date().toISOString().slice(0, 10);
  const report = auditKillDates(parsed.entries, today, (repoRelativePath) =>
    existsSync(path.join(root, repoRelativePath)),
  );
  report.violations.unshift(
    ...parsed.problems.map((problem) => `${REGISTRY_PATH}: ${problem}`),
  );
  const coverage = auditVendorCoverage(listVendoredPaths(root), parsed.entries);
  report.violations.push(...coverage.violations);
  report.violations.push(...auditVendorDrift(parsed.entries, root).violations);
  if (parsed.entries.length === 0 && parsed.problems.length === 0) {
    report.notes.push("no temporary paths are registered.");
  }
  reportAndExit("check:killdates", report);
}

if (import.meta.main) main();
