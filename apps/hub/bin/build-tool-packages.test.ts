import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

import {
  buildToolPackages,
  TOOL_PACKAGES,
  type BuiltToolPackage,
} from "./build-tool-packages";

const scratch = path.join(os.tmpdir(), `wb-tool-packages-${process.pid}`);
const spec = TOOL_PACKAGES.find(
  (s) => s.name === "@workbench/tools-hackernews",
);
if (spec === undefined) {
  throw new Error("expected @workbench/tools-hackernews in TOOL_PACKAGES");
}

let entry: BuiltToolPackage;
let outDir: string;

// A single in-process `Bun.build` for all shape assertions — invoking
// the bundler repeatedly in one process races on the arktype dep store.
// The determinism test re-runs the packer in an independent subprocess.
beforeAll(async () => {
  outDir = path.join(scratch, "out");
  const built = await buildToolPackages([spec], outDir);
  expect(built).toHaveLength(1);
  entry = built[0]!;
});

afterAll(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

async function extractTarball(
  tarballPath: string,
  into: string,
): Promise<string> {
  await fs.mkdir(into, { recursive: true });
  await tar.extract({ file: tarballPath, cwd: into });
  return path.join(into, "package");
}

describe("build-tool-packages", () => {
  test("produces a <basename>-<version>.tgz tarball with an SRI integrity", async () => {
    expect(entry.name).toBe("@workbench/tools-hackernews");
    expect(path.basename(entry.tarballPath)).toBe(
      `@workbench-tools-hackernews-${entry.version}.tgz`,
    );
    expect(entry.integrity).toMatch(/^sha512-/);
    await fs.access(path.join(outDir, path.basename(entry.tarballPath)));
  });

  test("the packed package.json points at the bundled entry and drops workspace deps", async () => {
    const pkgRoot = await extractTarball(
      path.join(outDir, path.basename(entry.tarballPath)),
      path.join(scratch, "shape"),
    );
    const raw = await fs.readFile(path.join(pkgRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    expect(pkg.interchange).toEqual({ tools: "./dist/interchange-tools.js" });
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.exports).toBeUndefined();
  });

  test("the bundled entry is a self-contained ESM file with no bare @intx import", async () => {
    const pkgRoot = await extractTarball(
      path.join(outDir, path.basename(entry.tarballPath)),
      path.join(scratch, "entry"),
    );
    const bundled = await fs.readFile(
      path.join(pkgRoot, "dist", "interchange-tools.js"),
      "utf-8",
    );
    expect(bundled).toContain("@workbench/tools-hackernews/hackernews");
    expect(bundled).not.toContain('from "@intx/agent"');
  });

  test("an independent build run reproduces the same SRI integrity", async () => {
    const proc = Bun.spawn(["bun", "run", "bin/build-tool-packages.ts"], {
      cwd: path.resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout).toContain(entry.integrity);
  });
});
