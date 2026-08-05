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
