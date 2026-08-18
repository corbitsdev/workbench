// Proves a tool package whose `src/` moved without a version bump fails
// loud — the failure mode `publishCorbitsToolsRegistry` cannot catch,
// because it skips an already-published name@version rather than
// comparing source. Fixtures are scratch git repos so this suite does
// not depend on the worktree's own dirty tool packages.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const proc = Bun.spawn(
    [
      "git",
      "-c",
      "user.email=freshness@test",
      "-c",
      "user.name=Freshness",
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
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

async function committedPackage(src: string): Promise<{
  root: string;
  pkg: string;
}> {
  const root = await scratchDir("corbits-tools-freshness-");
  await git(root, ["init", "-b", "main"]);
  const pkg = path.join(root, "fake-tools");
  await writePkg(pkg, "0.0.1", src);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial @corbits/fake-tools@0.0.1"]);
  return { root, pkg };
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
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "src change, forgot the bump"]);

    await expect(
      checkToolPackageFreshness({ packageDirs: [pkg] }),
    ).rejects.toBeInstanceOf(StaleToolPackageError);
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
