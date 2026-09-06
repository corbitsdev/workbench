// Drives the workspace script runner through its real command line against a
// throwaway fixture workspace. This runner gates every commit for everyone, so
// a swallowed exit code or a package silently skipped here would break the
// merge gate with nothing to catch it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { parseShardArg, resolveConcurrency, selectShard } from "./run-all.ts";

const RUNNER = join(import.meta.dir, "run-all.ts");

// Each probe brackets a sleep with a start/end line in a shared log, which is
// what lets a test reconstruct how many probes were in flight at once without
// depending on wall-clock timing.
const PROBE_SOURCE = `import { appendFile } from "node:fs/promises";
import { basename } from "node:path";

const log = process.env["PROBE_LOG"] ?? "";
const name = basename(process.cwd());

await appendFile(log, \`start:\${name}\\n\`);
await Bun.sleep(250);
await appendFile(log, \`end:\${name}\\n\`);
console.log(\`probe ran in \${name}\`);

if (process.env["PROBE_FAIL"] === name) process.exit(1);
`;

const WITH_PROBE = ["alpha", "bravo", "charlie", "delta"] as const;
const WITHOUT_PROBE = "echo-only";
// The root gate's own "test" script fans out across packages exactly
// like any other script now (see run-all.ts's resolveConcurrency); it
// gets its own probe run below purely to prove that specific script name
// carries no special-cased concurrency any more.
const TEST_SCRIPT = "test";

let workspace = "";
let logCounter = 0;

async function writePackage(
  root: string,
  name: string,
  scripts: Record<string, string>,
): Promise<void> {
  const dir = join(root, "packages", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: `@fixture/${name}`, scripts }, null, 2),
  );
}

type RunnerResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly log: string;
};

async function runProbe(
  extraEnv: Record<string, string> = {},
  script = "probe",
  extraArgs: readonly string[] = [],
): Promise<RunnerResult> {
  logCounter += 1;
  const logPath = join(workspace, `probe-${logCounter}.log`);
  await writeFile(logPath, "");

  // The parent process may have WORKBENCH_CHECK_CONCURRENCY set for the
  // gate itself. Default-concurrency probes must not inherit it; tests that
  // intend an override pass the var in extraEnv.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PROBE_LOG: logPath,
    ...extraEnv,
  };
  if (!Object.hasOwn(extraEnv, "WORKBENCH_CHECK_CONCURRENCY")) {
    delete env["WORKBENCH_CHECK_CONCURRENCY"];
  }

  const child = Bun.spawn(["bun", "run", RUNNER, script, ...extraArgs], {
    cwd: workspace,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stdout, stderr, log: await readFile(logPath, "utf8") };
}

/** Peak number of probes running at the same moment, from the shared log. */
function peakOverlap(log: string): number {
  let current = 0;
  let peak = 0;
  for (const line of log.split("\n")) {
    if (line.startsWith("start:")) {
      current += 1;
      peak = Math.max(peak, current);
    } else if (line.startsWith("end:")) {
      current -= 1;
    }
  }
  return peak;
}

describe("run-all", () => {
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "workbench-run-all-"));
    for (const name of WITH_PROBE) {
      await writePackage(workspace, name, {
        probe: "bun run probe.ts",
        [TEST_SCRIPT]: "bun run probe.ts",
      });
      await writeFile(
        join(workspace, "packages", name, "probe.ts"),
        PROBE_SOURCE,
      );
    }
    await writePackage(workspace, WITHOUT_PROBE, { other: "true" });

    const vendorDir = join(workspace, "vendor", "intx", "vendor-probe");
    await mkdir(vendorDir, { recursive: true });
    await writeFile(
      join(vendorDir, "package.json"),
      JSON.stringify(
        { name: "@intx/vendor-probe", scripts: { probe: "bun run probe.ts" } },
        null,
        2,
      ),
    );
    await writeFile(join(vendorDir, "probe.ts"), PROBE_SOURCE);
  });

  afterAll(async () => {
    if (workspace !== "") await rm(workspace, { recursive: true, force: true });
  });

  test("runs the script in every package that defines it, and only those", async () => {
    const result = await runProbe();

    for (const name of WITH_PROBE) {
      expect(result.stdout).toContain(`probe ran in ${name}`);
    }
    expect(result.stdout).not.toContain(WITHOUT_PROBE);
    expect(result.exitCode).toBe(0);
  });

  test("runs the script in vendored packages under vendor/intx too", async () => {
    const result = await runProbe();

    expect(result.stdout).toContain("probe ran in vendor-probe");
    expect(result.exitCode).toBe(0);
  });

  test("runs packages concurrently rather than one at a time", async () => {
    const result = await runProbe({ WORKBENCH_CHECK_CONCURRENCY: "4" });

    expect(peakOverlap(result.log)).toBeGreaterThan(1);
  });

  test("never exceeds the configured concurrency", async () => {
    const result = await runProbe({ WORKBENCH_CHECK_CONCURRENCY: "2" });

    expect(peakOverlap(result.log)).toBeLessThanOrEqual(2);
    for (const name of WITH_PROBE) {
      expect(result.stdout).toContain(`probe ran in ${name}`);
    }
  });

  test("runs the test script concurrently like any other script", async () => {
    const result = await runProbe(
      { WORKBENCH_CHECK_CONCURRENCY: "4" },
      TEST_SCRIPT,
    );

    expect(peakOverlap(result.log)).toBeGreaterThan(1);
    for (const name of WITH_PROBE) {
      expect(result.stdout).toContain(`probe ran in ${name}`);
    }
  });

  test("honours an explicit concurrency for the test script", async () => {
    const result = await runProbe(
      { WORKBENCH_CHECK_CONCURRENCY: "3" },
      TEST_SCRIPT,
    );

    expect(peakOverlap(result.log)).toBeGreaterThan(1);
  });

  test("rejects a concurrency setting that is not a positive integer", async () => {
    const result = await runProbe({ WORKBENCH_CHECK_CONCURRENCY: "0" });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("WORKBENCH_CHECK_CONCURRENCY");
  });

  test("uses every core in GitHub Actions and leaves two free locally", () => {
    expect(resolveConcurrency("typecheck", {}, 8)).toBe(6);
    expect(resolveConcurrency("typecheck", { GITHUB_ACTIONS: "true" }, 8)).toBe(
      8,
    );
    expect(
      resolveConcurrency(
        "typecheck",
        { GITHUB_ACTIONS: "true", WORKBENCH_CHECK_CONCURRENCY: "3" },
        8,
      ),
    ).toBe(3);
    expect(resolveConcurrency("test", { GITHUB_ACTIONS: "true" }, 8)).toBe(8);
    expect(resolveConcurrency("test", {}, 8)).toBe(6);
  });

  test("fails the run and names the package whose script failed", async () => {
    const result = await runProbe({ PROBE_FAIL: "charlie" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("@fixture/charlie");
  });

  test("keeps a failing package from cancelling its siblings", async () => {
    const result = await runProbe({ PROBE_FAIL: "charlie" });

    for (const name of WITH_PROBE) {
      expect(result.stdout).toContain(`probe ran in ${name}`);
    }
  });

  test("attributes each package's output to that package", async () => {
    const result = await runProbe();

    for (const name of WITH_PROBE) {
      const header = result.stdout.indexOf(`@fixture/${name}`);
      const output = result.stdout.indexOf(`probe ran in ${name}`);
      expect(header).toBeGreaterThanOrEqual(0);
      expect(header).toBeLessThan(output);
    }
  });

  test("reports when no package defines the script", async () => {
    const child = Bun.spawn(["bun", "run", RUNNER, "nothing-defines-this"], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("no workspace packages define it");
  });

  test("fixture workspace holds only the packages the tests declare", () => {
    expect(basename(workspace).startsWith("workbench-run-all-")).toBe(true);
  });

  test("splits a package run across shards with --shard i/n", async () => {
    const results = await Promise.all(
      [1, 2, 3].map((i) => runProbe({}, "probe", ["--shard", `${i}/3`])),
    );

    const ranIn = (stdout: string) =>
      WITH_PROBE.filter((name) => stdout.includes(`probe ran in ${name}`));
    const allRun = results.flatMap((r) => ranIn(r.stdout));

    // Every package the fixture declares runs exactly once across the
    // three shards combined — none dropped, none run twice.
    expect(allRun.sort()).toEqual([...WITH_PROBE].sort());
    for (const result of results) expect(result.exitCode).toBe(0);
  });

  test("rejects a malformed --shard argument", async () => {
    const result = await runProbe({}, "probe", ["--shard", "bogus"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--shard");
  });

  test("selectShard partitions a stably-ordered job list with no overlap", () => {
    const jobs = Array.from({ length: 10 }, (_, i) => ({
      name: `pkg-${i}`,
      dir: `packages/pkg-${i}`,
    }));
    const shards = [1, 2, 3].map((i) =>
      selectShard(jobs, parseShardArg(`${i}/3`)),
    );

    const combined = shards.flatMap((s) => s.map((j) => j.name)).sort();
    expect(combined).toEqual(jobs.map((j) => j.name).sort());
  });

  test("parseShardArg rejects an out-of-range or malformed shard", () => {
    expect(() => parseShardArg("bogus")).toThrow();
    expect(() => parseShardArg("0/3")).toThrow();
    expect(() => parseShardArg("4/3")).toThrow();
  });
});
