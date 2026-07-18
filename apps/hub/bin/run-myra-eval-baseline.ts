/**
 * Admin-local wrapper: run the Myra v1 eval baseline (CL-3193).
 * Forwards argv to packages/myra/src/eval/run-baseline.ts.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../..");
const target = join(REPO_ROOT, "packages/myra/src/eval/run-baseline.ts");
const result = spawnSync("bun", ["run", target, ...process.argv.slice(2)], {
  cwd: REPO_ROOT,
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status === null ? 1 : result.status);
