// Database initialization is owned by the shared script at
// scripts/db-setup.ts; the setup verb consumes it as a child process —
// the one surface every runnable script guarantees — so this package
// never re-implements migrations. The script inherits stdio, so its
// own loud failure reporting reaches the operator verbatim.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "@workbench/hub-client";

export function createDbSetupRunner(repoRoot: string): () => Promise<void> {
  return async () => {
    const script = join(repoRoot, "scripts", "db-setup.ts");
    if (!existsSync(script)) {
      throw new CliError(
        `the database setup script is missing: ${script}`,
        "restore it from version control (`git checkout -- scripts/db-setup.ts`), then re-run: workbench setup",
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
        `database initialization failed: scripts/db-setup.ts exited with code ${code}`,
        "fix the problem it reported above (is Postgres running and DATABASE_URL correct?), then re-run: workbench setup",
      );
    }
  };
}
