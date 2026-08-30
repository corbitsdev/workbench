// Builds the composite project-reference graph with `tsc --build`, so
// TypeScript's own incremental engine (dependency order, skip anything
// already up to date) replaces the per-package fanout this script used to
// run: 94 independent `tsc --noEmit` processes that could not share a
// single result and each re-checked the full source of every transitive
// workspace dependency.
//
// `tsc --build` is invoked against a single generated solution file
// (`tsconfig.build.json`, a `references`-only manifest kept in sync by
// scripts/generate-tsconfig-references.ts), not against every composite
// project's tsconfig.json as separate command-line roots. Handing it many
// unrelated roots in one invocation was tried first and produces incorrect
// results: `tsc --build` shares source-file/diagnostic state across sibling
// root arguments, and can misattribute a `rootDir` violation from one
// project's dependency graph to a project that has nothing to do with it.
// A single root project (however it reaches every other project, via
// `references`) does not have this problem, and still gets the same
// dependency-order build with the same up-to-date skipping.
//
// A package's `test/` directory is checked separately, after the build:
// see scripts/generate-tsconfig-references.ts for why it cannot join the
// composite graph. Those checks aren't referenced by anything (they are
// leaves), so unlike the build they parallelize safely.
//
// A handful of packages sit in a real circular `dependencies` cycle, import
// one of the shared root scripts (`scripts/e2e`, `scripts/db-setup`,
// `test/isolation`) from their own `src`, or depend -- even transitively --
// on a package that does (see scripts/generate-tsconfig-references.ts), and
// are excluded from the composite graph entirely -- `tsconfig.test.json`
// absent is the signal. They fall back to the pre-change per-package
// `tsc -p tsconfig.json --noEmit` fanout, run in parallel alongside the
// test-project pass. Those three shared root scripts are themselves plain,
// non-composite projects covered by the root `tsconfig.json` and
// `test/isolation/tsconfig.json` checks below.
import { Glob } from "bun";

import { resolveConcurrency } from "./concurrency.ts";

const PROJECT_GLOBS = [
  "apps/*/tsconfig.json",
  "packages/*/tsconfig.json",
  "tools/*/tsconfig.json",
  "workflows/*/tsconfig.json",
  "vendor/intx/*/tsconfig.json",
];

async function discoverDirs(): Promise<string[]> {
  const dirs: string[] = [];
  for (const pattern of PROJECT_GLOBS) {
    const glob = new Glob(pattern);
    for await (const path of glob.scan(".")) {
      dirs.push(path.slice(0, -"/tsconfig.json".length));
    }
  }
  return dirs;
}

async function partitionByComposite(
  dirs: readonly string[],
): Promise<{ composite: string[]; cyclic: string[] }> {
  const composite: string[] = [];
  const cyclic: string[] = [];
  for (const dir of dirs) {
    if (await Bun.file(`${dir}/tsconfig.test.json`).exists()) {
      composite.push(dir);
    } else {
      cyclic.push(dir);
    }
  }
  return { composite, cyclic };
}

async function run(command: string[]): Promise<number> {
  const proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

async function runInParallel(commands: readonly string[][]): Promise<boolean> {
  if (commands.length === 0) return true;
  const concurrency = resolveConcurrency();
  let index = 0;
  let ok = true;
  async function worker(): Promise<void> {
    while (index < commands.length) {
      const command = commands[index];
      index += 1;
      if (command === undefined) return;
      const code = await run(command);
      if (code !== 0) ok = false;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, commands.length) }, worker),
  );
  return ok;
}

const allDirs = await discoverDirs();
const { composite: compositeDirs, cyclic: cyclicDirs } =
  await partitionByComposite(allDirs);

const buildCode = await run(["bunx", "tsc", "--build", "tsconfig.build.json"]);
if (buildCode !== 0) process.exit(buildCode);

const testProjectCommands: string[][] = [];
for (const dir of compositeDirs) {
  const path = `${dir}/tsconfig.test.json`;
  if (await Bun.file(path).exists()) {
    testProjectCommands.push(["bunx", "tsc", "-p", path, "--noEmit"]);
  }
}
const cyclicCommands = cyclicDirs.map((dir) => [
  "bunx",
  "tsc",
  "-p",
  `${dir}/tsconfig.json`,
  "--noEmit",
]);

const otherChecksOk = await runInParallel([
  ...testProjectCommands,
  ...cyclicCommands,
]);

const [rootCode, isolationCode] = await Promise.all([
  run(["bunx", "tsc", "-p", "tsconfig.json", "--noEmit"]),
  run(["bunx", "tsc", "-p", "test/isolation/tsconfig.json", "--noEmit"]),
]);
if (!otherChecksOk || rootCode !== 0 || isolationCode !== 0) {
  process.exit(1);
}
