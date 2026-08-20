// Database initialization is owned by the shared script at
// scripts/db-setup.ts; the setup verb consumes it as a child process —
// the one surface every runnable script guarantees — so this package
// never re-implements migrations. The script inherits stdio, so its
// own loud failure reporting reaches the operator verbatim.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "@workbench/hub-client";

function createScriptRunner(
  repoRoot: string,
  scriptRelativePath: string,
  verb: string,
  failureHint: string,
): () => Promise<void> {
  return async () => {
    const script = join(repoRoot, ...scriptRelativePath.split("/"));
    if (!existsSync(script)) {
      throw new CliError(
        `the ${verb} script is missing: ${script}`,
        `restore it from version control (\`git checkout -- ${scriptRelativePath}\`), then re-run: workbench ${verb}`,
      );
    }
    const child = Bun.spawn(["bun", script], {
      cwd: repoRoot,
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await child.exited;
    if (code !== 0) {
      throw new CliError(
        `${verb} failed: ${scriptRelativePath} exited with code ${code}`,
        `${failureHint}, then re-run: workbench ${verb}`,
      );
    }
  };
}

export function createDbSetupRunner(repoRoot: string): () => Promise<void> {
  return createScriptRunner(
    repoRoot,
    "scripts/db-setup.ts",
    "setup",
    "fix the problem it reported above (is Postgres running and DATABASE_URL correct?)",
  );
}

export function createResetRunner(repoRoot: string): () => Promise<void> {
  return createScriptRunner(
    repoRoot,
    "scripts/reset.ts",
    "reset",
    "fix the problem it reported above (is Postgres running, and does DATABASE_URL point at your local database?)",
  );
}
