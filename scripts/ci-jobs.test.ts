// Pins the CI job split so a flake names the suite that failed, and so
// checkout depth / cache keys cannot silently revert to the old shared job.
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
const POSTGRES_IMAGE = "pgvector/pgvector:pg17";
const DB_JOBS = ["e2e", "isolation", "db-suites"] as const;
const MERGE_BASE_JOBS = ["typecheck", "build-test", "structural"] as const;

test("CI splits e2e, isolation, and db-suites onto their own Postgres jobs", async () => {
  const yaml = await readFile(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const jobs = jobBodies(yaml);

  expect(yaml).not.toContain("E2E_REQUIRED");
  expect(yaml).not.toContain("CHECK_BASE_REF");

  expect(jobs.has("walking-skeleton")).toBe(false);
  for (const name of DB_JOBS) {
    const body = jobs.get(name);
    expect(body).toBeDefined();
    expect(body).toContain("postgres:");
    expect(body).toContain(`image: ${POSTGRES_IMAGE}`);
    expect(body).toContain(`uses: ${SETUP}`);
    expect(body).not.toContain("fetch-depth: 0");
  }

  const dbSuites = jobs.get("db-suites") ?? "";
  expect(dbSuites).toContain("bun test apps/hub/test");
  expect(dbSuites).toContain("grep -rl DATABASE_URL");

  // Unlike e2e and isolation, which provision their own schema through
  // the harness, apps/hub/test and most package suites connect straight
  // to DATABASE_URL or its `_e2e`-suffixed sibling from
  // `e2eDatabaseUrl()` — both databases must exist and be migrated
  // before those suites run, or their queries fail with "database ...
  // does not exist".
  const plainSetupIndex = dbSuites.indexOf(
    "postgres://postgres:postgres@localhost:5432/workbench bun scripts/db-setup.ts",
  );
  const e2eSetupIndex = dbSuites.indexOf(
    "postgres://postgres:postgres@localhost:5432/workbench_e2e bun scripts/db-setup.ts",
  );
  const hubSuiteIndex = dbSuites.indexOf("bun test apps/hub/test");
  expect(plainSetupIndex).toBeGreaterThan(-1);
  expect(e2eSetupIndex).toBeGreaterThan(-1);
  expect(plainSetupIndex).toBeLessThan(hubSuiteIndex);
  expect(e2eSetupIndex).toBeLessThan(hubSuiteIndex);
});

test("jobs that need merge-base fetch full history; the rest stay shallow", async () => {
  const yaml = await readFile(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const jobs = jobBodies(yaml);

  for (const name of MERGE_BASE_JOBS) {
    const body = jobs.get(name);
    expect(body).toBeDefined();
    expect(body).toContain(`uses: ${SETUP}`);
    expect(body).toContain("fetch-depth: 0");
  }

  const lint = jobs.get("lint");
  expect(lint).toBeDefined();
  expect(lint).toContain(`uses: ${SETUP}`);
  expect(lint).not.toContain("fetch-depth: 0");
});

test("lint cache keys on tool and config versions, not an OS-wide restore", async () => {
  const yaml = await readFile(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const lint = jobBodies(yaml).get("lint") ?? "";

  expect(lint).toContain(
    "hashFiles('bun.lock', 'eslint.config.ts', '.prettierrc.json', '.bun-version')",
  );
  expect(lint).not.toContain("lint-${{ runner.os }}-${{ github.sha }}");
  expect(lint).not.toContain("restore-keys: lint-${{ runner.os }}-");
});

test("setup-workbench caches bun install and node_modules on the lockfile", async () => {
  const action = await readFile(
    join(ROOT, ".github/actions/setup-workbench/action.yml"),
    "utf8",
  );

  expect(action).toContain("using: composite");
  expect(action).not.toContain("actions/checkout");
  expect(action).not.toContain("fetch-depth:");
  expect(action).toContain(
    "key: bun-${{ runner.os }}-${{ hashFiles('bun.lock', '.bun-version') }}",
  );
  expect(action).toContain(
    "key: node-modules-${{ runner.os }}-${{ hashFiles('bun.lock', '.bun-version') }}",
  );
  expect(action).not.toContain("restore-keys:");
  expect(action).toContain("bun install --frozen-lockfile");
});
