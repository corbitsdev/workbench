// Cheap-gate hook: skip env must not spawn lint, and the hook must not
// invoke the heavy suites that stay on GitHub CI.
import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "git-hooks", "pre-push");
const INSTALLER = join(import.meta.dir, "hooks-install.ts");

const HEAVY_SUITE_MARKERS = [
  "test:e2e",
  "walking-skeleton",
  "check:structural",
] as const;

function ambientEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const {
    CI: _ci,
    GITHUB_ACTIONS: _gha,
    SKIP_WORKBENCH_HOOKS: _skip,
    GIT_DIR: _gitDir,
    GIT_WORK_TREE: _gitWorkTree,
    GIT_CONFIG_GLOBAL: _global,
    GIT_CONFIG_SYSTEM: _system,
    ...rest
  } = process.env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", ...overrides };
}

async function spawnCapture(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(cmd, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: opts.env ?? ambientEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function writeBunStub(dir: string, logPath: string): Promise<void> {
  const bunPath = join(dir, "bun");
  await writeFile(
    bunPath,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath}"\n`,
    "utf-8",
  );
  await chmod(bunPath, 0o755);
}

describe("pre-push hook", () => {
  test("exits 0 immediately when SKIP_WORKBENCH_HOOKS is set and does not spawn lint", async () => {
    const work = await mkdtemp(join(tmpdir(), "pre-push-skip-"));
    try {
      await chmod(HOOK, 0o755);
      const logPath = join(work, "bun.log");
      await writeBunStub(work, logPath);
      const result = await spawnCapture([HOOK], {
        env: ambientEnv({
          PATH: `${work}:${process.env.PATH ?? ""}`,
          SKIP_WORKBENCH_HOOKS: "1",
        }),
      });
      expect(result.code).toBe(0);
      expect(await Bun.file(logPath).exists()).toBe(false);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test("exits 0 immediately when CI is set and does not spawn lint", async () => {
    const work = await mkdtemp(join(tmpdir(), "pre-push-ci-"));
    try {
      await chmod(HOOK, 0o755);
      const logPath = join(work, "bun.log");
      await writeBunStub(work, logPath);
      const result = await spawnCapture([HOOK], {
        env: ambientEnv({
          PATH: `${work}:${process.env.PATH ?? ""}`,
          CI: "true",
        }),
      });
      expect(result.code).toBe(0);
      expect(await Bun.file(logPath).exists()).toBe(false);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test("runs lint, typecheck, and unit tests through bun, not e2e", async () => {
    const work = await mkdtemp(join(tmpdir(), "pre-push-gates-"));
    try {
      await chmod(HOOK, 0o755);
      const repo = join(work, "repo");
      await spawnCapture(["git", "init", "--initial-branch=main", repo], {});
      const logPath = join(work, "bun.log");
      await writeBunStub(work, logPath);
      const result = await spawnCapture([HOOK], {
        cwd: repo,
        env: ambientEnv({
          PATH: `${work}:${process.env.PATH ?? ""}`,
        }),
      });
      expect(result.code).toBe(0);
      const log = await readFile(logPath, "utf-8");
      expect(log).toContain("run lint");
      expect(log).toContain("run typecheck");
      expect(log).toContain("run test");
      expect(log).not.toContain("test:e2e");
      expect(log).not.toContain("walking-skeleton");
      expect(log).not.toContain("check:structural");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test("does not mention test:e2e or walking-skeleton as a command it runs", async () => {
    const source = await readFile(HOOK, "utf-8");
    for (const marker of HEAVY_SUITE_MARKERS) {
      expect(source).not.toContain(marker);
    }
    expect(source).toContain("bun run lint");
    expect(source).toContain("bun run typecheck");
    expect(source).toContain("bun run test");
    expect(source).toContain("WORKBENCH_CHECK_SINCE");
    expect(source).toContain("origin/main");
  });
});

describe("hooks:install", () => {
  test("does not mention test:e2e or walking-skeleton as a command it runs", async () => {
    const source = await readFile(INSTALLER, "utf-8");
    for (const marker of HEAVY_SUITE_MARKERS) {
      expect(source).not.toContain(marker);
    }
  });

  test("sets repo-local core.hooksPath when CI is unset", async () => {
    const work = await mkdtemp(join(tmpdir(), "hooks-install-"));
    try {
      await spawnCapture(["git", "init", "--initial-branch=main", work], {});
      const result = await spawnCapture(["bun", "run", INSTALLER], {
        cwd: work,
        env: ambientEnv(),
      });
      expect(result.code).toBe(0);
      const hooksPath = await spawnCapture(
        ["git", "config", "--local", "--get", "core.hooksPath"],
        { cwd: work, env: ambientEnv() },
      );
      expect(hooksPath.stdout.trim()).toBe("scripts/git-hooks");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test("is a no-op in CI and does not set core.hooksPath", async () => {
    const work = await mkdtemp(join(tmpdir(), "hooks-install-ci-"));
    try {
      await spawnCapture(["git", "init", "--initial-branch=main", work], {});
      const result = await spawnCapture(["bun", "run", INSTALLER], {
        cwd: work,
        env: ambientEnv({ CI: "true" }),
      });
      expect(result.code).toBe(0);
      const hooksPath = await spawnCapture(
        ["git", "config", "--local", "--get", "core.hooksPath"],
        { cwd: work, env: ambientEnv() },
      );
      expect(hooksPath.code).not.toBe(0);
      expect(hooksPath.stdout.trim()).toBe("");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test("is a no-op when GITHUB_ACTIONS is set", async () => {
    const work = await mkdtemp(join(tmpdir(), "hooks-install-gha-"));
    try {
      await spawnCapture(["git", "init", "--initial-branch=main", work], {});
      const result = await spawnCapture(["bun", "run", INSTALLER], {
        cwd: work,
        env: ambientEnv({ GITHUB_ACTIONS: "true" }),
      });
      expect(result.code).toBe(0);
      const hooksPath = await spawnCapture(
        ["git", "config", "--local", "--get", "core.hooksPath"],
        { cwd: work, env: ambientEnv() },
      );
      expect(hooksPath.stdout.trim()).toBe("");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
