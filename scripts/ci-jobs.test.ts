// Pins the shape of the single fast CI workflow (CL-8150) so a future
// edit can't silently reintroduce the sharded/db-suite/e2e machinery it
// replaced, or drop one of the five required jobs.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function jobBodies(yaml: string): Map<string, string> {
  const marker = "\njobs:\n";
  const jobsIndex = yaml.indexOf(marker);
  if (jobsIndex < 0) throw new Error("ci.yml has no jobs: block");
  const jobsSection = yaml.slice(jobsIndex + marker.length);
  const heading = /^ {2}([a-z][a-z0-9-]*):$/gm;
  const matches = [...jobsSection.matchAll(heading)];
  const bodies = new Map<string, string>();
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i]?.[1];
    if (name === undefined) continue;
    const start = (matches[i]?.index ?? 0) + (matches[i]?.[0].length ?? 0);
    const end = matches[i + 1]?.index ?? jobsSection.length;
    bodies.set(name, jobsSection.slice(start, end));
  }
  return bodies;
}

const SETUP = "./.github/actions/setup-workbench";
const EXPECTED_JOBS = ["setup", "typecheck", "lint", "structural", "unit"] as const;

test("CI declares exactly the five fast jobs and nothing sharded/db-backed", async () => {
  const yaml = await readFile(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const jobs = jobBodies(yaml);

  expect([...jobs.keys()].sort()).toEqual([...EXPECTED_JOBS].sort());

  for (const name of ["typecheck", "lint", "structural", "unit"]) {
    expect(jobs.get(name)).toContain("needs: setup");
  }

  expect(yaml).not.toContain("postgres:");
  expect(yaml).not.toContain("matrix:");
  expect(yaml).not.toContain("--shard");
  expect(yaml).not.toContain("upload-artifact");
});

test("every job checks out and runs the setup-workbench action", async () => {
  const yaml = await readFile(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const jobs = jobBodies(yaml);

  for (const name of EXPECTED_JOBS) {
    const body = jobs.get(name);
    expect(body).toBeDefined();
    expect(body).toContain("uses: actions/checkout@v4");
    expect(body).toContain(`uses: ${SETUP}`);
  }
});

test("only structural fetches full history; the rest stay shallow", async () => {
  const yaml = await readFile(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const jobs = jobBodies(yaml);

  expect(jobs.get("structural")).toContain("fetch-depth: 0");
  for (const name of ["setup", "typecheck", "lint", "unit"]) {
    expect(jobs.get(name)).not.toContain("fetch-depth: 0");
  }
});

test("lint runs oxlint and oxfmt --check; the unit job has a hard timeout", async () => {
  const yaml = await readFile(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const jobs = jobBodies(yaml);

  const lint = jobs.get("lint") ?? "";
  expect(lint).toContain("bun run lint");
  expect(lint).toContain("bun run fmt:check");

  const unit = jobs.get("unit") ?? "";
  expect(unit).toContain("timeout-minutes: 10");
  expect(unit).toContain("bun test apps packages workflows scripts");
});

test("the structural job runs the same list as local check:structural", async () => {
  const yaml = await readFile(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const structural = jobBodies(yaml).get("structural") ?? "";

  expect(structural).toContain("bun run check:structural");
  // One list: CI must not re-enumerate the structural sub-checks, or
  // local and CI drift the moment a new check: script is added.
  expect(structural).not.toContain("check:deletion");
  expect(structural).not.toContain("check:report-error");
  expect(structural).not.toContain("check:packages");
});

test("setup-workbench caches the bun install cache on the lockfile", async () => {
  const action = await readFile(join(ROOT, ".github/actions/setup-workbench/action.yml"), "utf8");

  expect(action).toContain("using: composite");
  expect(action).not.toContain("actions/checkout");
  expect(action).not.toContain("fetch-depth:");
  expect(action).toContain(
    "key: bun-${{ runner.os }}-${{ hashFiles('bun.lock', '.bun-version') }}",
  );
  expect(action).toContain("bun install --frozen-lockfile");
});
