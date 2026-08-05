import { expect, test } from "bun:test";
import { auditKillDates, parseKillDates } from "../killdates";

test("parseKillDates reads rows and skips comments", () => {
  const parsed = parseKillDates(
    "# header\nvendor/thing | ada | 2026-12-31\n\n",
  );
  expect(parsed.problems).toEqual([]);
  expect(parsed.entries).toEqual([
    { path: "vendor/thing", owner: "ada", killDate: "2026-12-31" },
  ]);
});

test("parseKillDates rejects malformed rows and bad dates", () => {
  const parsed = parseKillDates(
    "vendor/thing | ada\nvendor/other | ada | soon\n",
  );
  expect(parsed.entries).toEqual([]);
  expect(parsed.problems).toHaveLength(2);
  expect(parsed.problems[0]).toContain("path | owner | YYYY-MM-DD");
  expect(parsed.problems[1]).toContain('"soon"');
});

test("a passed kill date on a surviving path is a violation naming the owner", () => {
  const report = auditKillDates(
    [{ path: "vendor/thing", owner: "ada", killDate: "2026-01-01" }],
    "2026-01-02",
    () => true,
  );
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("vendor/thing");
  expect(report.violations[0]).toContain("2026-01-01 has passed");
  expect(report.violations[0]).toContain("owner: ada");
});

test("the kill date itself is still within the grace of the entry", () => {
  const report = auditKillDates(
    [{ path: "vendor/thing", owner: "ada", killDate: "2026-01-01" }],
    "2026-01-01",
    () => true,
  );
  expect(report.violations).toEqual([]);
  expect(report.notes).toHaveLength(1);
});

test("a future kill date passes with a note", () => {
  const report = auditKillDates(
    [{ path: "vendor/thing", owner: "ada", killDate: "2027-01-01" }],
    "2026-01-02",
    () => true,
  );
  expect(report.violations).toEqual([]);
  expect(report.notes[0]).toContain("temporary until 2027-01-01");
});

test("a registered path that no longer exists is a stale-row violation", () => {
  const report = auditKillDates(
    [{ path: "vendor/thing", owner: "ada", killDate: "2027-01-01" }],
    "2026-01-02",
    () => false,
  );
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("stale row");
});
