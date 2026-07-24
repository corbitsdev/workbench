/**
 * Single pre-deploy entry point for Railway.
 *
 * Railway executes `preDeployCommand` without a shell, so `&&`-chained
 * commands are passed as literal arguments to the first script — the chain
 * silently ran only the skill-drafts drain in production and skipped
 * db-setup entirely (missing `work_unit` et al.). This script owns the
 * ordering instead: drain skill-draft artifact rows BEFORE db-setup runs
 * migration 0079 (drops artifact.status), then seed. Fail-closed: any
 * non-zero step aborts the deploy.
 */

const STEPS: string[][] = [
  ["bun", "run", "apps/hub/bin/migrate-skill-drafts-to-assets.ts", "--yes"],
  ["bun", "run", "scripts/db-setup.ts"],
  ["bun", "run", "apps/hub/bin/seed-startup.ts"],
];

for (const cmd of STEPS) {
  console.log(`[pre-deploy] running: ${cmd.join(" ")}`);
  const proc = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    console.error(
      `[pre-deploy] step failed with exit code ${proc.exitCode}: ${cmd.join(" ")}`,
    );
    process.exit(proc.exitCode ?? 1);
  }
}

console.log("[pre-deploy] all steps completed.");
