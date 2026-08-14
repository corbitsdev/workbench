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
//
// Documented product-domain exceptions live in ALLOWLIST below. Each
// entry is an explicit ruling: the named file may declare up to
// `maxOccurrences` product tables because they hold package-owned
// state the platform deliberately does not own (chat settings, cron
// schedules, webhook bindings, etc.). Tenancy, principals, and grants
// still stay native. Any other `pgTable(` occurrence fails, and an
// allowlisted file fails if it grows past its max.
import { Glob } from "bun";
import path from "node:path";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

const SCAN_DIRS = ["apps", "packages", "workflows"];
// Matches the plain `pgTable(...)` builder and `xyzSchema.table(...)` —
// the form every package now uses to declare tables inside its own named
// Postgres schema (see docs/package-migrations.md). Both are drizzle table
// declarations and both count toward a file's allowlisted occurrences;
// only the declaration style differs.
const PGTABLE_CALL_PATTERN = /\bpgTable\s*\(|\b\w+Schema\.table\s*\(/g;

const ALLOWLIST: readonly {
  relPath: string;
  maxOccurrences: number;
  tables: readonly string[];
}[] = [
  {
    relPath: "packages/chat/src/schema.ts",
    maxOccurrences: 12,
    tables: [
      "channel_settings",
      "chat_bench_settings",
      "channel_read_state",
      "channel_launch",
      "channel_tenancy",
      "channel_threads",
      "channel_thread_messages",
      "channel_share",
      "channel_share_member",
      "block_responses",
      "message_reactions",
      "pinned_messages",
    ],
  },
  {
    relPath: "packages/routines/src/schema.ts",
    maxOccurrences: 3,
    tables: ["routine", "routine_run", "routine_draft"],
  },
  {
    relPath: "packages/webhook-triggers/src/schema.ts",
    maxOccurrences: 1,
    tables: ["webhook_trigger"],
  },
  {
    relPath: "packages/notify/src/schema.ts",
    maxOccurrences: 1,
    tables: ["notify_dispatch"],
  },
  {
    relPath: "packages/insights/src/schema.ts",
    maxOccurrences: 2,
    tables: ["usage_turn", "model_price"],
  },
  {
    relPath: "packages/bench/src/schema.ts",
    maxOccurrences: 1,
    tables: ["bench_settings"],
  },
];

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

function countPgTableCalls(contents: string): number {
  return [...contents.matchAll(PGTABLE_CALL_PATTERN)].length;
}

export function auditProductTenancy(
  files: readonly { relPath: string; contents: string }[],
): CheckReport {
  const report = emptyReport();
  for (const { relPath, contents } of files) {
    const occurrences = countPgTableCalls(contents);
    if (occurrences === 0) continue;

    const allowed = ALLOWLIST.find((entry) => entry.relPath === relPath);
    if (allowed === undefined) {
      report.violations.push(
        `${relPath}: calls pgTable(...). All persistent state is native ` +
          `Interchange schema under vendor/intx/db — a drizzle table ` +
          `declared in apps/, packages/, or workflows/ is a product-owned ` +
          `duplicate of platform schema, never a design choice. Product ` +
          `domain tables need an explicit ALLOWLIST ruling in ` +
          `scripts/checks/no-product-tenancy.ts.`,
      );
      continue;
    }
    if (occurrences > allowed.maxOccurrences) {
      report.violations.push(
        `${relPath}: declares ${occurrences} pgTable(...) call(s), more than ` +
          `the ${allowed.maxOccurrences} allowed for this file ` +
          `(${allowed.tables.join(", ")}). Any new product table needs its ` +
          `own explicit ALLOWLIST ruling, not a quiet addition to this file.`,
      );
      continue;
    }
    report.notes.push(
      `${relPath}: ${occurrences} pgTable(...) call(s) allowed ` +
        `(${allowed.tables.join(", ")})`,
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
  const report = auditProductTenancy(files);
  report.notes.push(
    `scanned ${files.length} file(s) under ${SCAN_DIRS.join(", ")}`,
  );
  reportAndExit("check:no-product-tenancy", report);
}

if (import.meta.main) await main();
