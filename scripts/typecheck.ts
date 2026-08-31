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
// project's tsconfig.src.json as separate command-line roots. Handing it
// many unrelated roots in one invocation was tried first and produces
// incorrect results: `tsc --build` shares source-file/diagnostic state
// across sibling root arguments, and can misattribute a `rootDir`
// violation from one project's dependency graph to a project that has
// nothing to do with it. A single root project (however it reaches every
// other project, via `references`) does not have this problem, and still
// gets the same dependency-order build with the same up-to-date skipping.
//
// Every package's combined `tsconfig.json` (src + test together) is then
// checked separately, in parallel -- see scripts/generate-tsconfig-references.ts
// for why the composite src-only project (`tsconfig.src.json`, used only by
// the build above and by composite dependents' `references`) can't include
// test files itself. This is the same shape for every package regardless
// of whether it has a `tsconfig.src.json` at all: a package excluded from
// the composite graph entirely (a real dependency cycle, or a transitive
// consumer of one) never had a split in the first place, and its plain
// `tsconfig.json` already covers src + test together.
import { Glob } from "bun";

import { resolveConcurrency } from "./concurrency.ts";

const PROJECT_GLOBS = [
  "apps/*/tsconfig.json",
  "packages/*/tsconfig.json",
  "tools/*/tsconfig.json",
  "workflows/*/tsconfig.json",
  "vendor/intx/*/tsconfig.json",
];

async function discoverProjectPaths(): Promise<string[]> {
  const paths: string[] = [];
  for (const pattern of PROJECT_GLOBS) {
    const glob = new Glob(pattern);
    for await (const path of glob.scan(".")) {
      paths.push(path);
    }
  }
  return paths;
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

const buildCode = await run(["bunx", "tsc", "--build", "tsconfig.build.json"]);
if (buildCode !== 0) process.exit(buildCode);

const projectPaths = await discoverProjectPaths();
const projectCommands = projectPaths.map((path) => [
  "bunx",
  "tsc",
  "-p",
  path,
  "--noEmit",
]);

const projectsOk = await runInParallel(projectCommands);

const [rootCode, isolationCode] = await Promise.all([
  run(["bunx", "tsc", "-p", "tsconfig.json", "--noEmit"]),
  run(["bunx", "tsc", "-p", "test/isolation/tsconfig.json", "--noEmit"]),
]);
if (!projectsOk || rootCode !== 0 || isolationCode !== 0) {
  process.exit(1);
}
