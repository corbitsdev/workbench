// check:changeset-ignore — `.changeset/config.json`'s `ignore` list must
// match the workspace's actual `private: true` packages (CL-8167). The
// list is generated, never hand-typed (`bun run scripts/gen-changeset-config.ts`
// regenerates it); this check fails when a package flips `private`
// without that regeneration, so changesets never opens a version PR for
// a package this repo cannot publish, and never silently skips one that
// just became publishable.
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildChangesetConfig } from "../gen-changeset-config.ts";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

export async function auditChangesetIgnore(root: string): Promise<CheckReport> {
  const report = emptyReport();
  const expected = await buildChangesetConfig(root);
  const configPath = path.join(root, ".changeset", "config.json");
  const actualRaw = readFileSync(configPath, "utf8");
  const expectedRaw = `${JSON.stringify(expected, null, 2)}\n`;
  if (actualRaw !== expectedRaw) {
    report.violations.push(
      ".changeset/config.json is stale — run `bun run scripts/gen-changeset-config.ts` " +
        "and commit the result (it recomputes `ignore` from every workspace package's " +
        "`private` flag).",
    );
  }
  return report;
}

async function main(): Promise<void> {
  const root = rootFromArgs(process.argv.slice(2));
  const report = await auditChangesetIgnore(root);
  reportAndExit("changeset-ignore", report);
}

if (import.meta.main) await main();
