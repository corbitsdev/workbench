import { expect, test } from "bun:test";
import {
  auditHubJunkCommits,
  isSourcePath,
  JUNK_COMMIT_SUBJECTS,
  LARGE_COMMIT_FILE_THRESHOLD,
  type InspectedCommit,
} from "../hub-git-safety";

function commit(overrides: Partial<InspectedCommit>): InspectedCommit {
  return {
    hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    subject: "Bound the workflow-artifact rate limiter's per-run map",
    authorEmail: "dev@example.com",
    files: ["apps/hub/src/index.ts"],
    ...overrides,
  };
}

test("a normal source commit passes", () => {
  expect(auditHubJunkCommits([commit({})]).violations).toEqual([]);
});

test("each known hub/seed subject is a violation naming the subject", () => {
  for (const subject of JUNK_COMMIT_SUBJECTS) {
    const report = auditHubJunkCommits([commit({ subject })]);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain(subject);
    expect(report.violations[0]).toContain("disposable HUB_DATA_DIR");
  }
});

test("a hub-authored commit is a violation even with a plausible subject", () => {
  const report = auditHubJunkCommits([
    commit({
      subject: "genesis",
      authorEmail: "hub@interchange.local",
    }),
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("hub@interchange.local");
});

test("a seed-authored commit is a violation", () => {
  const report = auditHubJunkCommits([
    commit({
      subject: "push workflow",
      authorEmail: "seed@workbench.localhost",
    }),
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("seed@workbench.localhost");
});

test("committing .data/hub paths is a violation", () => {
  const report = auditHubJunkCommits([
    commit({
      files: [".data/hub/assets/workflow/assistant/.git/HEAD"],
    }),
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain(".data/hub");
});

test("a large commit with no source-tree file is a violation", () => {
  const files = Array.from(
    { length: LARGE_COMMIT_FILE_THRESHOLD + 1 },
    (_, i) => `object-${i}`,
  );
  const report = auditHubJunkCommits([commit({ files })]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("no corresponding source-tree change");
});

test("a large commit that also changes source passes the size heuristic", () => {
  const files = [
    "apps/hub/src/index.ts",
    ...Array.from(
      { length: LARGE_COMMIT_FILE_THRESHOLD },
      (_, i) => `extra-${i}`,
    ),
  ];
  expect(auditHubJunkCommits([commit({ files })]).violations).toEqual([]);
});

test("isSourcePath rejects hub data even under apps/", () => {
  expect(isSourcePath("apps/hub/src/index.ts")).toBe(true);
  expect(isSourcePath("apps/hub/.data/hub/HEAD")).toBe(false);
  expect(isSourcePath(".data/hub/HEAD")).toBe(false);
});
