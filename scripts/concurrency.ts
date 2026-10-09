// Shared worker-pool sizing for the two scripts that fan out `tsc`/package
// scripts across the workspace (run-all.ts, typecheck.ts). Each job saturates
// about one core, so the default leaves a couple free for the editor and
// type server a developer runs alongside the gate.
import { availableParallelism } from "node:os";

export const CONCURRENCY_ENV = "WORKBENCH_CHECK_CONCURRENCY";

export function resolveConcurrency(
  env: NodeJS.ProcessEnv = process.env,
  cores: number = availableParallelism(),
): number {
  const raw = env[CONCURRENCY_ENV];
  if (raw === undefined || raw === "") {
    // Locally each job saturates about one core, so leave a couple free for
    // the editor and type server a developer runs alongside the gate. CI
    // runners have no editor — use every core so fan-out is not artificially
    // capped.
    if (env["GITHUB_ACTIONS"] === "true") return Math.max(1, cores);
    return Math.max(1, cores - 2);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${CONCURRENCY_ENV} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}
