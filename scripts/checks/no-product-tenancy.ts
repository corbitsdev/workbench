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
import { emptyReport, reportAndExit, rootFromArgs, type CheckReport } from "./lib/repo";

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
    maxOccurrences: 16,
    tables: [
      // Created as channel_settings et al.; renamed to workbench_* by
      // 0018_rename_channel_to_workbench (CL-6260) — see migrations.ts.
      "workbench_settings",
      "chat_bench_settings",
      "workbench_read_state",
      "workbench_launch",
      "workbench_threads",
      "workbench_thread_messages",
      "workbench_share",
      "workbench_share_member",
      "block_responses",
      "message_reactions",
      "pinned_messages",
      // Durable redelivery-dedup claim for the finalized-turn write
      // surfaces (CL-6039) — see finalizedTurnWriteClaim's doc comment
      // in schema.ts.
      "finalized_turn_write_claim",
      "message_client_ids",
      // The room's own messages (CL-6327): a workbench message is
      // workbench data, held here rather than read back out of the
      // anchor run's mailbox — see room-messages.ts.
      "workbench_messages",
      // The turn projection (CL-6329): one row per agent turn, so a room
      // answers "which run produced this reply, and how did that turn
      // end" from its own rows — see agentTurns in schema.ts.
      "agent_turns",
      // Which workbench message a dispatch mail answers (CL-6314): the
      // reply path threads under that source. Chat-owned correlation,
      // not tenancy — see turnMailCorrelation in schema.ts.
      "turn_mail_correlation",
    ],
  },
  {
    relPath: "packages/webhook-triggers/src/schema.ts",
    maxOccurrences: 4,
    tables: [
      // CL-8210: `tenant`/`principal` are Interchange's own tables,
      // re-declared here (id column only, never migrated) just far
      // enough to carry the FK from webhook_trigger/repo_review_lease —
      // same pattern as @corbits/artifacts's src/schema.ts.
      "tenant",
      "principal",
      "webhook_trigger",
      // CL-7242: a short-lived lease serializing the GitHub connect
      // card's former start-reviewing step (workbench-scoped mount
      // deleted in hub-zero T3, CL-8114; the lease still backs the
      // native `startReviewingRepos` helper), entirely workbench-owned
      // state with no relationship to Interchange's own `grant` table —
      // see repo-review-lease.ts's doc comment for why the concurrency
      // fix lives here rather than as any change to Interchange's
      // schema.
      "repo_review_lease",
    ],
  },
  {
    relPath: "packages/notify/src/schema.ts",
    maxOccurrences: 3,
    tables: [
      // CL-8210: Interchange's own `tenant`/`principal`, re-declared
      // (id column only, never migrated) to carry the FK from
      // notify_dispatch — same pattern as @corbits/artifacts.
      "tenant",
      "principal",
      "notify_dispatch",
    ],
  },
  {
    relPath: "packages/bench/src/schema.ts",
    maxOccurrences: 1,
    tables: ["bench_settings"],
  },
  {
    // A bench's model policy: its allow/deny selectors, price ceilings
    // and provider preference. The platform's catalog owns what a bench
    // can reach; what a bench is willing to spend on it is a product
    // decision with nowhere native to live. Everything else this package
    // answers is derived at read time from model_offering and
    // model_pricing — see docs/inference-concepts.md.
    relPath: "packages/inference-catalog/src/schema.ts",
    maxOccurrences: 1,
    tables: ["bench_model_policy"],
  },
  {
    relPath: "packages/onboarding/src/schema.ts",
    maxOccurrences: 2,
    tables: [
      // CL-8210: Interchange's own `tenant`, re-declared (id column
      // only, never migrated) to carry the FK from pending_seed.
      "tenant",
      "pending_seed",
    ],
  },
  {
    // Eval-run history (CL-6143): one row per (eval, config) scored
    // run, product-owned scoring data, never tenancy.
    relPath: "packages/evals/src/store/schema.ts",
    maxOccurrences: 1,
    tables: ["evals.run"],
  },
  {
    // CL-8183: the vendored Interchange workflow-trigger grammar has no
    // `schedule` trigger, so `@corbits/cron` fires a tenant's saved cron
    // expressions as plain mail instead. Product-owned schedule state,
    // never tenancy — FK'd back to the native `tenant` table.
    relPath: "packages/cron/src/schema.ts",
    maxOccurrences: 2,
    // CL-8210: Interchange's `tenant` re-declared (id only, never migrated)
    // to carry the FK from cron.schedule.
    tables: ["tenant", "cron.schedule"],
  },
];

export async function scanFiles(root: string, dirs: readonly string[]): Promise<string[]> {
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
      `${relPath}: ${occurrences} pgTable(...) call(s) allowed ` + `(${allowed.tables.join(", ")})`,
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
  report.notes.push(`scanned ${files.length} file(s) under ${SCAN_DIRS.join(", ")}`);
  reportAndExit("check:no-product-tenancy", report);
}

if (import.meta.main) await main();
