// check:no-product-tenancy — a structural invariant, not a spelling
// taboo: every table Interchange needs for tenants, principals, roles,
// grants, and invites already exists as native schema under
// `vendor/intx/db`. Nothing in `apps/`, `packages/`, or `workflows/`
// should ever declare its own `pgTable(...)` — any drizzle table
// exported from product code would be exactly the kind of duplicate
// the platform already gives us for free, tenancy or otherwise. This
// check greps for the actual drizzle API call, `pgTable(`, never for a
// naming convention or a string that merely mentions tenancy — a
// comment or variable name that happens to say "tenant" is never a
// violation, only a real call is.
import { Glob } from "bun";
import path from "node:path";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

const SCAN_DIRS = ["apps", "packages", "workflows"];
const PGTABLE_CALL_PATTERN = /\bpgTable\s*\(/;

export async function scanFiles(
  root: string,
  dirs: readonly string[],
): Promise<string[]> {
  const files: string[] = [];
  for (const dir of dirs) {
    const glob = new Glob(`${dir}/**/*.{ts,tsx}`);
    for await (const file of glob.scan({ cwd: root, dot: false })) {
      // vendor/intx and node_modules never appear under apps/packages/
      // workflows globs directly, but a package can still vendor its
      // own node_modules under packages/*/node_modules — exclude it.
      if (file.includes("node_modules/")) continue;
      if (file.includes("/dist/") || file.startsWith("dist/")) continue;
      files.push(file);
    }
  }
  return files;
}

export function auditProductTenancy(
  files: readonly { relPath: string; contents: string }[],
): CheckReport {
  const report = emptyReport();
  for (const { relPath, contents } of files) {
    if (PGTABLE_CALL_PATTERN.test(contents)) {
      report.violations.push(
        `${relPath}: calls pgTable(...). All persistent state is native ` +
          `Interchange schema under vendor/intx/db — a drizzle table ` +
          `declared in apps/, packages/, or workflows/ is a product-owned ` +
          `duplicate of platform schema, never a design choice.`,
      );
    }
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
  const report = auditProductTenancy(files);
  report.notes.push(
    `scanned ${files.length} file(s) under ${SCAN_DIRS.join(", ")}`,
  );
  reportAndExit("check:no-product-tenancy", report);
}

if (import.meta.main) await main();
