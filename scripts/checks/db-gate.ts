// check:db-gate — every DB-gated suite must skip through dbGate
// (scripts/e2e/db-gate.ts), never a hand-rolled
// `databaseUrl ? describe.skip : describe` ternary. A hand-rolled gate
// skips in total silence and never honors CI=true — exactly
// the gap CL-7279 closed, one file at a time, until the next merge
// added a new hand-rolled copy the sweep never saw. This check makes
// the invariant self-enforcing instead of a one-time sweep.
//
// vendor/intx is excluded: editing inside a vendored tree carries
// re-pin tax, so its (small, pre-existing) hand-rolled gates are left
// alone — see VENDORED.md.
import { Glob } from "bun";
import path from "node:path";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

const SCAN_DIRS = ["apps", "packages", "scripts"];
const HAND_ROLLED_GATE_PATTERN =
  /const\s+describeIfDb\s*=\s*\w+\s*===\s*(?:undefined|"")\s*\?\s*describe\.skip\s*:\s*describe;/;

export async function scanFiles(
  root: string,
  dirs: readonly string[],
): Promise<string[]> {
  const files: string[] = [];
  for (const dir of dirs) {
    const glob = new Glob(`${dir}/**/*.test.ts`);
    for await (const file of glob.scan({ cwd: root, dot: false })) {
      if (file.includes("node_modules/")) continue;
      // This check's own test fixtures deliberately contain the
      // hand-rolled pattern as string literals, not real gates.
      if (file.startsWith("scripts/checks/")) continue;
      files.push(file);
    }
  }
  return files;
}

export function auditDbGate(
  files: readonly { relPath: string; contents: string }[],
): CheckReport {
  const report = emptyReport();
  for (const { relPath, contents } of files) {
    if (!HAND_ROLLED_GATE_PATTERN.test(contents)) continue;
    report.violations.push(
      `${relPath}: hand-rolls a describeIfDb gate instead of using dbGate ` +
        `from scripts/e2e/db-gate.ts. A hand-rolled gate skips silently ` +
        `and never honors CI=true — replace it with ` +
        `\`const describeIfDb = dbGate(databaseUrl, import.meta.path);\`.`,
    );
  }
  return report;
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const root = rootFromArgs(args);
  const relPaths = await scanFiles(root, SCAN_DIRS);
  const files = await Promise.all(
    relPaths.map(async (relPath) => ({
      relPath,
      contents: await Bun.file(path.join(root, relPath)).text(),
    })),
  );
  const report = auditDbGate(files);
  report.notes.push(
    `scanned ${files.length} *.test.ts file(s) under ${SCAN_DIRS.join(", ")}`,
  );
  reportAndExit("check:db-gate", report);
}

if (import.meta.main) await main();
