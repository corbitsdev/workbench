// check:killdates — kill dates for temporary paths.
//
// scripts/checks/kill-dates.txt registers every temporary path with an
// owner and a kill date; this check fails once the date has passed
// while the path still exists, and fails on stale rows whose path is
// already gone. Vendored code (see VENDORED.md) and short-lived
// bridges register here in the same change that introduces them.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

export const REGISTRY_PATH = "scripts/checks/kill-dates.txt";

export interface KillDateEntry {
  /** Repo-relative path of the temporary code. */
  path: string;
  owner: string;
  /** ISO date (YYYY-MM-DD) after which the path may no longer exist. */
  killDate: string;
}

export interface ParsedKillDates {
  entries: KillDateEntry[];
  problems: string[];
}

/** Rows are `path | owner | YYYY-MM-DD`; `#` comments and blanks ignored. */
export function parseKillDates(text: string): ParsedKillDates {
  const parsed: ParsedKillDates = { entries: [], problems: [] };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const columns = line.split("|").map((column) => column.trim());
    const [entryPath, owner, killDate] = columns;
    if (
      columns.length !== 3 ||
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
    parsed.entries.push({ path: entryPath, owner, killDate });
  }
  return parsed;
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
  if (parsed.entries.length === 0 && parsed.problems.length === 0) {
    report.notes.push("no temporary paths are registered.");
  }
  reportAndExit("check:killdates", report);
}

if (import.meta.main) main();
