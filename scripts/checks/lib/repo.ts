// Shared plumbing for the structural checks. Every check builds a
// CheckReport of violations (blocking) and notes (informational) and
// exits through reportAndExit, so output shape and exit codes are
// uniform across checks.
import path from "node:path";

/** Absolute path of the repository root this script tree lives in. */
export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

/**
 * Resolves the tree a check runs against. Defaults to the repository
 * root; `--root=<dir>` points the check at another tree, which is how
 * the checks are exercised against deliberately broken fixtures.
 */
export function rootFromArgs(argv: readonly string[]): string {
  for (const arg of argv) {
    if (arg.startsWith("--root=")) {
      return path.resolve(arg.slice("--root=".length));
    }
  }
  return REPO_ROOT;
}

/** Positional arguments, with `--root=` and other flags stripped. */
export function positionalArgs(argv: readonly string[]): string[] {
  return argv.filter((arg) => !arg.startsWith("--"));
}

export interface CheckReport {
  violations: string[];
  notes: string[];
}

export function emptyReport(): CheckReport {
  return { violations: [], notes: [] };
}

/**
 * Prints a report and exits: 0 when there are no violations, 1
 * otherwise. Notes never affect the exit code.
 */
export function reportAndExit(name: string, report: CheckReport): never {
  for (const note of report.notes) {
    console.log(`${name}: note: ${note}`);
  }
  if (report.violations.length > 0) {
    for (const violation of report.violations) {
      console.error(`${name}: ${violation}`);
    }
    console.error(
      `${name}: FAIL — ${report.violations.length} violation(s) above`,
    );
    process.exit(1);
  }
  console.log(`${name}: ok`);
  process.exit(0);
}
