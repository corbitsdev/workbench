import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { auditReplacedPaths, parseLedger } from "../deletion";

test("parseLedger skips comments and blank lines", () => {
  const paths = parseLedger("# header\n\napps/hub/src/old.ts\npackages/x\n");
  expect(paths).toEqual(["apps/hub/src/old.ts", "packages/x"]);
});

test("a ledgered path that still exists is a violation naming it", () => {
  const report = auditReplacedPaths(["apps/hub/src/old.ts"], () => true);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("apps/hub/src/old.ts");
  expect(report.violations[0]).toContain("still exists");
  expect(report.violations[0]).toContain("Hard cutover");
});

test("a ledgered path that is gone passes", () => {
  const report = auditReplacedPaths(["apps/hub/src/old.ts"], () => false);
  expect(report.violations).toEqual([]);
});

test("only the surviving paths are reported", () => {
  const report = auditReplacedPaths(
    ["gone.ts", "alive.ts"],
    (candidate) => candidate === "alive.ts",
  );
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("alive.ts");
});

// Empty leftover package dirs from the installer review (13) plus five more
// found at pickup. Git already dropped them; the replacement ledger keeps
// them from coming back as workspace members.
const DELETED_HUSK_PACKAGES = [
  "packages/agent-workflow-authoring",
  "packages/cli",
  "packages/echo",
  "packages/folded-run-one-shot",
  "packages/folded-runs",
  "packages/hub-client",
  "packages/routines",
  "packages/routines-tools",
  "packages/sidecar-placement",
  "packages/task-dispatch-tools",
  "packages/task-planner",
  "packages/tasks",
  "packages/tasks-ui",
  "packages/workflow-catalog",
  "packages/workflow-deploy-source",
  "packages/workflow-freeze",
  "packages/workflow-host-actions",
  "packages/workflow-source",
];

test("deleted husk packages stay on the replacement ledger and are gone", () => {
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const ledger = parseLedger(
    readFileSync(
      path.join(repoRoot, "scripts/checks/replaced-paths.txt"),
      "utf8",
    ),
  );
  for (const husk of DELETED_HUSK_PACKAGES) {
    expect(ledger).toContain(husk);
    expect(existsSync(path.join(repoRoot, husk))).toBe(false);
  }
});
