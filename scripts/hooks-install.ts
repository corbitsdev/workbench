// Sets this checkout's local core.hooksPath to scripts/git-hooks so
// `git push` runs lint, typecheck, and unit tests. No-op in CI so
// `bun install` does not rewrite GitHub Actions git config.

const HOOKS_PATH = "scripts/git-hooks";

function flagSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

function main(): void {
  if (flagSet(process.env.CI) || flagSet(process.env.GITHUB_ACTIONS)) {
    return;
  }
  if (Bun.which("git") === null) {
    return;
  }

  const toplevel = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (toplevel.exitCode !== 0) {
    return;
  }

  const root = toplevel.stdout.toString().trim();
  const result = Bun.spawnSync(
    ["git", "config", "--local", "core.hooksPath", HOOKS_PATH],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    const detail =
      `${result.stdout.toString()}${result.stderr.toString()}`.trim();
    console.error(
      detail.length > 0
        ? `hooks:install failed: ${detail}`
        : "hooks:install failed: git config core.hooksPath",
    );
    process.exit(result.exitCode ?? 1);
  }
}

if (import.meta.main) {
  main();
}
