// check:deletion — donor deletion, the mechanical half of hard cutover.
//
// scripts/checks/replaced-paths.txt is the ledger of in-repo paths that
// ported code claims to have replaced. A change that replaces a path
// adds it to the ledger in the same commit that deletes it; this check
// fails while any ledgered path still exists, so a replacement can
// never quietly leave the old path alive beside the new one. Extra
// paths may be passed as arguments for ad hoc use.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  emptyReport,
  positionalArgs,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

export const LEDGER_PATH = "scripts/checks/replaced-paths.txt";

/** One path per line; blank lines and `#` comments ignored. */
export function parseLedger(text: string): string[] {
  const paths: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    paths.push(line);
  }
  return paths;
}

export function auditReplacedPaths(
  paths: readonly string[],
  exists: (repoRelativePath: string) => boolean,
): CheckReport {
  const report = emptyReport();
  for (const replaced of paths) {
    if (!exists(replaced)) continue;
    report.violations.push(
      `${replaced}: a change claimed to replace this path, but it still ` +
        `exists. Hard cutover means the replaced path is deleted in the ` +
        `same change that replaces it — delete it now, or remove its ` +
        `row from ${LEDGER_PATH} if the replacement claim was wrong.`,
    );
  }
  return report;
}

function main(): void {
  const args = Bun.argv.slice(2);
  const root = rootFromArgs(args);
  const ledgerFile = path.join(root, LEDGER_PATH);
  const ledgered = existsSync(ledgerFile)
    ? parseLedger(readFileSync(ledgerFile, "utf8"))
    : [];
  const paths = [...ledgered, ...positionalArgs(args)];
  const report = auditReplacedPaths(paths, (repoRelativePath) =>
    existsSync(path.join(root, repoRelativePath)),
  );
  if (paths.length === 0) {
    report.notes.push("the replaced-paths ledger is empty.");
  }
  reportAndExit("check:deletion", report);
}

if (import.meta.main) main();
