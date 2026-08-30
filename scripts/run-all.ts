// Runs a package.json script in every workspace package that defines it.
// Succeeds when no package defines it, so root gates stay green while the
// workspace is still empty.
import { Glob } from "bun";
import { availableParallelism } from "node:os";

import { SEQUENTIAL_SCRIPTS } from "./sequential-scripts.ts";

const CONCURRENCY_ENV = "WORKBENCH_CHECK_CONCURRENCY";

type Job = { readonly name: string; readonly dir: string };

export function resolveConcurrency(
  script: string,
  env: NodeJS.ProcessEnv = process.env,
  cores: number = availableParallelism(),
): number {
  const raw = env[CONCURRENCY_ENV];
  if (raw === undefined || raw === "") {
    if (SEQUENTIAL_SCRIPTS.has(script)) return 1;
    // Locally each job saturates about one core, so leave a couple free for
    // the editor and type server a developer runs alongside the gate. CI
    // runners have no editor — use every core so package fan-out is not
    // artificially capped.
    if (env["GITHUB_ACTIONS"] === "true") return Math.max(1, cores);
    return Math.max(1, cores - 2);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `${CONCURRENCY_ENV} must be a positive integer, got "${raw}"`,
    );
  }
  return parsed;
}

// Bun's Glob silently matches nothing when a brace alternative contains a
// slash (e.g. "{apps,vendor/intx}/*/package.json"), so each workspace root
// gets its own glob rather than one combined brace pattern.
const WORKSPACE_ROOTS = [
  "apps/*/package.json",
  "packages/*/package.json",
  "tools/*/package.json",
  "workflows/*/package.json",
  "vendor/intx/*/package.json",
];

async function discover(script: string): Promise<Job[]> {
  const jobs: Job[] = [];
  for (const pattern of WORKSPACE_ROOTS) {
    const glob = new Glob(pattern);
    for await (const manifestPath of glob.scan(".")) {
      const manifest = (await Bun.file(manifestPath).json()) as {
        name?: string;
        scripts?: Record<string, string>;
      };
      if (!manifest.scripts?.[script]) continue;
      const dir = manifestPath.slice(0, -"/package.json".length);
      jobs.push({ name: manifest.name ?? dir, dir });
    }
  }
  return jobs;
}

// Output is captured and flushed as one block per package. Streaming it would
// interleave the lines of every concurrent job, leaving a failure with no
// reliable way to tell which package produced it.
async function runJob(job: Job, script: string): Promise<number> {
  const proc = Bun.spawn(["bun", "run", script], {
    cwd: job.dir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const body = `${stdout}${stderr}`;
  const trailingNewline = body.endsWith("\n") || body.length === 0 ? "" : "\n";
  process.stdout.write(
    `--- ${job.name}: ${script} ---\n${body}${trailingNewline}`,
  );
  return code;
}

const SINCE_ENV = "WORKBENCH_CHECK_SINCE";

/**
 * The files this change touches, relative to `ref`: everything committed since
 * the merge base, plus whatever is still uncommitted. Uncommitted work counts
 * because the gate runs before the commit exists.
 */
function changedFilesSince(ref: string): string[] {
  const base =
    Bun.spawnSync(["git", "merge-base", "HEAD", ref])
      .stdout.toString()
      .trim() || ref;
  const committed = Bun.spawnSync([
    "git",
    "diff",
    "--name-only",
    `${base}...HEAD`,
  ]);
  const working = Bun.spawnSync(["git", "status", "--porcelain"]);
  return [
    ...committed.stdout.toString().split("\n"),
    ...working.stdout
      .toString()
      .split("\n")
      .map((line) => line.slice(3)),
  ]
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
}

/**
 * Narrows the job list to packages this change can actually break. Opt-in:
 * without the env var every package runs, so CI and a bare `bun run check`
 * keep their existing all-packages meaning.
 */
async function narrowToAffected(jobs: readonly Job[]): Promise<Job[]> {
  const ref = process.env[SINCE_ENV];
  if (ref === undefined || ref === "") return [...jobs];

  const { affectedPackages, readManifests } = await import("./affected.ts");
  const affected = affectedPackages(
    changedFilesSince(ref),
    await readManifests(),
  );
  if (affected === "all") {
    console.error(
      `${SINCE_ENV}=${ref}: change is repo-wide, running every package`,
    );
    return [...jobs];
  }
  const narrowed = jobs.filter((job) => affected.has(job.name));
  console.error(
    `${SINCE_ENV}=${ref}: ${narrowed.length} of ${jobs.length} package(s) affected`,
  );
  return narrowed;
}

if (import.meta.main) {
  const scriptArg = process.argv[2];
  if (!scriptArg) {
    console.error("usage: bun run scripts/run-all.ts <script-name>");
    process.exit(1);
  }
  const script: string = scriptArg;

  let concurrency: number;
  try {
    concurrency = resolveConcurrency(script);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }

  const discovered = await discover(script);
  const jobs = await narrowToAffected(discovered);
  if (jobs.length === 0) {
    const reason =
      discovered.length === 0
        ? "no workspace packages define it yet"
        : "nothing affected by this change";
    console.log(`${script}: ${reason}`);
    process.exit(0);
  }

  const failures: string[] = [];
  let nextJob = 0;

  async function worker(): Promise<void> {
    while (nextJob < jobs.length) {
      const job = jobs[nextJob];
      nextJob += 1;
      if (job === undefined) return;

      // Progress goes to stderr so stdout stays a clean sequence of per-package
      // blocks; a ten-minute gate that prints nothing until the end reads as hung.
      console.error(`started ${job.name}`);
      const code = await runJob(job, script);
      if (code !== 0) {
        failures.push(job.name);
        console.error(`${job.name}: ${script} exited with code ${code}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
  );

  if (failures.length > 0) {
    console.error(
      `${script} failed in ${failures.length} package(s): ${failures.join(", ")}`,
    );
    process.exit(1);
  }
}
