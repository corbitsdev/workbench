// Proves a tool package whose `src/` moved without a version bump fails
// loud — the failure mode `publishCorbitsToolsRegistry` cannot catch,
// because it skips an already-published name@version rather than
// comparing source. Fixtures are scratch git repos so this suite does
// not depend on the worktree's own dirty tool packages. History is
// written with plumbing (`commit-tree`) under a test-owned git config
// so a developer `core.hooksPath` cannot fail the suite.
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CORBITS_TOOL_PACKAGE_DIRS } from "./registry";
import {
  assertToolPackagesFresh,
  checkToolPackageFreshness,
  snapshotToolPackages,
  staleToolPackages,
  StaleToolPackageError,
} from "./freshness-check";

const scratchDirs: string[] = [];
let fixtureGitConfig: string | undefined;

afterAll(async () => {
  await Promise.all(
    scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

async function fixtureGitEnv(): Promise<Record<string, string | undefined>> {
  if (fixtureGitConfig === undefined) {
    const dir = await scratchDir("corbits-tools-freshness-gitconfig-");
    const hooks = path.join(dir, "hooks");
    await mkdir(hooks);
    fixtureGitConfig = path.join(dir, "config");
    await writeFile(
      fixtureGitConfig,
      [
        "[user]",
        "\tname = Freshness",
        "\temail = freshness@test",
        "[core]",
        `\thooksPath = ${hooks}`,
        "[commit]",
        "\tgpgsign = false",
        "",
      ].join("\n"),
    );
  }
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: fixtureGitConfig,
  };
}

async function git(
  cwd: string,
  args: readonly string[],
  env?: Record<string, string | undefined>,
): Promise<string> {
  const proc = Bun.spawn(
    [
      "git",
      "-c",
      "core.hooksPath=",
      "-c",
      "user.email=freshness@test",
      "-c",
      "user.name=Freshness",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      env: env ?? (await fixtureGitEnv()),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return stdout.trim();
}

async function rawGit(
  cwd: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return stdout.trim();
}

// `git commit` runs the operator's commit-msg / author hooks. Plumbing
// writes the same history without that surface, so this suite does not
// depend on whoever owns `core.hooksPath` on the machine.
async function commitAll(
  root: string,
  message: string,
  env?: Record<string, string | undefined>,
): Promise<void> {
  await git(root, ["add", "."], env);
  const tree = await git(root, ["write-tree"], env);
  let parent: string | undefined;
  try {
    parent = await git(root, ["rev-parse", "--verify", "HEAD"], env);
  } catch {
    parent = undefined;
  }
  const sha =
    parent === undefined
      ? await git(root, ["commit-tree", tree, "-m", message], env)
      : await git(root, ["commit-tree", tree, "-p", parent, "-m", message], env);
  await git(root, ["update-ref", "HEAD", sha], env);
}

async function writePkg(
  pkg: string,
  version: string,
  src: string,
): Promise<void> {
  await mkdir(path.join(pkg, "src"), { recursive: true });
  await writeFile(
    path.join(pkg, "package.json"),
    `${JSON.stringify({ name: "@corbits/fake-tools", version }, null, 2)}\n`,
  );
  await writeFile(path.join(pkg, "src", "index.ts"), src);
}

async function committedPackage(
  src: string,
  env?: Record<string, string | undefined>,
): Promise<{
  root: string;
  pkg: string;
}> {
  const root = await scratchDir("corbits-tools-freshness-");
  await git(root, ["init", "-b", "main"], env);
  const pkg = path.join(root, "fake-tools");
  await writePkg(pkg, "0.0.1", src);
  await commitAll(root, "initial @corbits/fake-tools@0.0.1", env);
  return { root, pkg };
}

async function plantRejectingAuthorHook(): Promise<string> {
  const work = await scratchDir("corbits-tools-freshness-hooks-");
  const hooksDir = path.join(work, "hooks");
  await mkdir(hooksDir);
  const hook = path.join(hooksDir, "commit-msg");
  await writeFile(
    hook,
    [
      "#!/bin/sh",
      'echo "commit blocked: author must be listed in allowed-emails" >&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  await chmod(hook, 0o755);
  const globalConfig = path.join(work, "gitconfig");
  await writeFile(globalConfig, `[core]\nhooksPath = ${hooksDir}\n`);
  return globalConfig;
}

describe("staleToolPackages", () => {
  test("src-changed-without-bump is a finding", () => {
    expect(
      staleToolPackages([
        {
          name: "@corbits/fake-tools",
          dir: "/tmp/fake-tools",
          currentVersion: "0.0.1",
          publishedVersion: "0.0.1",
          srcChangedSincePublished: true,
        },
      ]),
    ).toEqual([
      {
        name: "@corbits/fake-tools",
        dir: "/tmp/fake-tools",
        version: "0.0.1",
      },
    ]);
  });

  test("a version bump clears the finding", () => {
    expect(
      staleToolPackages([
        {
          name: "@corbits/fake-tools",
          dir: "/tmp/fake-tools",
          currentVersion: "0.0.2",
          publishedVersion: "0.0.1",
          srcChangedSincePublished: true,
        },
      ]),
    ).toEqual([]);
  });

  test("unchanged src at the published version is fresh", () => {
    expect(
      staleToolPackages([
        {
          name: "@corbits/fake-tools",
          dir: "/tmp/fake-tools",
          currentVersion: "0.0.1",
          publishedVersion: "0.0.1",
          srcChangedSincePublished: false,
        },
      ]),
    ).toEqual([]);
  });

  test("a package with no published version is not stale", () => {
    expect(
      staleToolPackages([
        {
          name: "@corbits/fake-tools",
          dir: "/tmp/fake-tools",
          currentVersion: "0.0.1",
          publishedVersion: undefined,
          srcChangedSincePublished: true,
        },
      ]),
    ).toEqual([]);
  });
});

describe("assertToolPackagesFresh", () => {
  test("src-changed-without-bump is loud", () => {
    const snapshots = [
      {
        name: "@corbits/fake-tools",
        dir: "/tmp/fake-tools",
        currentVersion: "0.0.1",
        publishedVersion: "0.0.1",
        srcChangedSincePublished: true,
      },
    ] as const;

    expect(() => assertToolPackagesFresh(snapshots)).toThrow(
      StaleToolPackageError,
    );

    try {
      assertToolPackagesFresh(snapshots);
      throw new Error("expected StaleToolPackageError");
    } catch (err) {
      expect(err).toBeInstanceOf(StaleToolPackageError);
      const message = (err as StaleToolPackageError).message;
      expect(message).toContain("@corbits/fake-tools@0.0.1");
      expect(message).toContain("src/");
      expect(message).toContain("without bumping version");
      expect(message).toContain("name@version");
      expect(message).toContain("Bump the package.json version");
      expect(message).toContain("/tmp/fake-tools");
    }
  });
});

describe("checkToolPackageFreshness", () => {
  test("src-changed-without-bump is loud against a real git tree", async () => {
    const { pkg } = await committedPackage("export const n = 1;\n");
    await writePkg(pkg, "0.0.1", "export const n = 2;\n");

    let thrown: unknown;
    try {
      await checkToolPackageFreshness({ packageDirs: [pkg] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StaleToolPackageError);
    const message = (thrown as StaleToolPackageError).message;
    expect(message).toContain("@corbits/fake-tools@0.0.1");
    expect(message).toContain("src/");
    expect(message).toContain("without bumping version");
    expect(message).toContain("Bump the package.json version");
  });

  test("a new untracked src file without a bump is loud", async () => {
    const { pkg } = await committedPackage("export const n = 1;\n");
    await writeFile(
      path.join(pkg, "src", "extra.ts"),
      "export const extra = 1;\n",
    );

    await expect(
      checkToolPackageFreshness({ packageDirs: [pkg] }),
    ).rejects.toBeInstanceOf(StaleToolPackageError);
  });

  test("src changed together with a version bump is fresh", async () => {
    const { pkg } = await committedPackage("export const n = 1;\n");
    await writePkg(pkg, "0.0.2", "export const n = 2;\n");
    await checkToolPackageFreshness({ packageDirs: [pkg] });
  });

  test("unchanged src at the published version is fresh", async () => {
    const { pkg } = await committedPackage("export const n = 1;\n");
    await checkToolPackageFreshness({ packageDirs: [pkg] });
  });

  test("committed src change after the version-introducing commit is loud", async () => {
    const { root, pkg } = await committedPackage("export const n = 1;\n");
    await writePkg(pkg, "0.0.1", "export const n = 2;\n");
    await commitAll(root, "src change, forgot the bump");

    await expect(
      checkToolPackageFreshness({ packageDirs: [pkg] }),
    ).rejects.toBeInstanceOf(StaleToolPackageError);
  });

  test("fixture history is written even when a global author hook would reject git commit", async () => {
    const globalConfig = await plantRejectingAuthorHook();
    const hostileEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig,
    };

    const victim = await scratchDir("corbits-tools-freshness-victim-");
    await rawGit(
      victim,
      [
        "-c",
        "user.email=freshness@test",
        "-c",
        "user.name=Freshness",
        "init",
        "-b",
        "main",
      ],
      hostileEnv,
    );
    await writeFile(path.join(victim, "README"), "victim\n");
    await rawGit(victim, ["add", "."], hostileEnv);
    let unguarded: unknown;
    try {
      await rawGit(
        victim,
        [
          "-c",
          "user.email=freshness@test",
          "-c",
          "user.name=Freshness",
          "commit",
          "-m",
          "should be blocked",
        ],
        hostileEnv,
      );
    } catch (err) {
      unguarded = err;
    }
    expect(unguarded).toBeInstanceOf(Error);
    expect((unguarded as Error).message).toContain("allowed-emails");

    const { pkg } = await committedPackage(
      "export const n = 1;\n",
      hostileEnv,
    );
    await checkToolPackageFreshness({ packageDirs: [pkg] });
  });
});

describe("snapshotToolPackages", () => {
  test("defaults to the publish map", async () => {
    const snapshots = await snapshotToolPackages();
    expect(snapshots.map((snapshot) => snapshot.dir)).toEqual([
      ...CORBITS_TOOL_PACKAGE_DIRS,
    ]);
    expect(snapshots.length).toBe(CORBITS_TOOL_PACKAGE_DIRS.length);
    for (const snapshot of snapshots) {
      expect(snapshot.name.startsWith("@corbits/")).toBe(true);
      expect(snapshot.currentVersion.length).toBeGreaterThan(0);
    }
  });
});
