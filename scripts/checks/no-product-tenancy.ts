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
    maxOccurrences: 14,
    tables: [
      // Created as channel_settings et al.; renamed to workbench_* by
      // 0018_rename_channel_to_workbench (CL-6260) — see migrations.ts.
      "workbench_settings",
      "chat_bench_settings",
      "workbench_read_state",
      "workbench_launch",
      "workbench_tenancy",
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
    // `turn_latency` (CL-6257) records per-message-run latency stages —
    // product observability the platform's own tables never capture.
    relPath: "packages/insights/src/schema.ts",
    maxOccurrences: 3,
    tables: ["usage_turn", "model_price", "turn_latency"],
  },
  {
    // Append-only record of every public key a workflow run has been
    // deployed under, in its own `run_key_history` Postgres schema —
    // identity diagnostics the platform's `workflow_run.public_key`
    // (a single mutable column) cannot answer.
    relPath: "packages/run-key-history/src/schema.ts",
    maxOccurrences: 1,
    tables: ["run_key_history"],
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
    relPath: "packages/access-policy/src/schema.ts",
    maxOccurrences: 2,
    tables: ["policy", "pending_invite"],
  },
  {
    // `task_leg` records which agent runs make up one task and in what
    // order — product correlation, not delivery state. The platform's
    // own `workflow_run_dispatch` stays the authority on whether a
    // message was delivered; nothing about a workbench task's meaning
    // belongs in it.
    relPath: "packages/tasks/src/schema.ts",
    maxOccurrences: 2,
    tables: ["task", "task_leg"],
  },
  {
    relPath: "packages/onboarding/src/schema.ts",
    maxOccurrences: 1,
    tables: ["pending_seed"],
  },
  {
    relPath: "packages/slack-tag/src/schema.ts",
    maxOccurrences: 1,
    tables: ["slack_channel_binding"],
  },
  {
    relPath: "packages/skills/src/schema.ts",
    maxOccurrences: 1,
    tables: ["skill_access"],
  },
  {
    relPath: "packages/preferences/src/schema.ts",
    maxOccurrences: 1,
    tables: ["user_preferences"],
  },
  {
    relPath: "packages/folded-runs/src/schema.ts",
    maxOccurrences: 1,
    tables: ["folded_run"],
  },
  {
    // Skills pinned to a workbench's agent definition (CL-6135): the
    // workflow-kind asset tree forbids skills.json, so this pin list is
    // package-owned state beside the native definition row.
    relPath: "packages/agent-directory/src/schema.ts",
    maxOccurrences: 1,
    tables: ["agent_directory.definition_skills"],
  },
  {
    // Eval-run history (CL-6143): one row per (eval, config) scored
    // run, product-owned scoring data, never tenancy.
    relPath: "packages/evals/src/store/schema.ts",
    maxOccurrences: 1,
    tables: ["evals.run"],
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
