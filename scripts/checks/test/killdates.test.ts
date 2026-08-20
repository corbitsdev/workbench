import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  auditKillDates,
  auditVendorCoverage,
  auditVendorDrift,
  listVendoredPaths,
  parseKillDates,
} from "../killdates";
import { hashDirectory } from "../lib/tree-hash";

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
  expect(report.violations[0]).toContain("delete it");
  expect(report.violations[0]).toContain("VENDORED.md");
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

test("listVendoredPaths finds directories two levels under vendor/, not files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "killdates-test-"));
  try {
    mkdirSync(path.join(root, "vendor", "intx", "log"), { recursive: true });
    mkdirSync(path.join(root, "vendor", "intx", "agent"), { recursive: true });
    writeFileSync(path.join(root, "vendor", "intx", "LICENSE"), "LGPL");
    writeFileSync(path.join(root, "vendor", "stray-file"), "");
    expect(listVendoredPaths(root)).toEqual([
      path.join("vendor", "intx", "agent"),
      path.join("vendor", "intx", "log"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listVendoredPaths is empty when there is no vendor directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "killdates-test-"));
  try {
    expect(listVendoredPaths(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a vendored directory with no registry row is a violation", () => {
  const report = auditVendorCoverage(["@intx/log"], []);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("@intx/log");
  expect(report.violations[0]).toContain("no row");
});

test("a registered vendored directory passes coverage", () => {
  const report = auditVendorCoverage(
    ["@intx/log"],
    [{ path: "@intx/log", owner: "ada", killDate: "2027-01-01" }],
  );
  expect(report.violations).toEqual([]);
});

test("parseKillDates reads an optional hash column", () => {
  const parsed = parseKillDates(
    "vendor/thing | ada | 2026-12-31 | " + "a".repeat(64) + "\n",
  );
  expect(parsed.problems).toEqual([]);
  expect(parsed.entries[0]?.hash).toBe("a".repeat(64));
});

test("an unchanged vendored tree passes the drift audit", () => {
  const root = mkdtempSync(path.join(tmpdir(), "killdates-test-"));
  try {
    mkdirSync(path.join(root, "vendor", "intx", "log"), { recursive: true });
    writeFileSync(path.join(root, "vendor", "intx", "log", "index.ts"), "hi");
    const hash = hashDirectory(path.join(root, "vendor", "intx", "log"));
    const report = auditVendorDrift(
      [{ path: "@intx/log", owner: "ada", killDate: "2027-01-01", hash }],
      root,
    );
    expect(report.violations).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a byte edit in a vendored tree is a drift violation naming the package", () => {
  const root = mkdtempSync(path.join(tmpdir(), "killdates-test-"));
  try {
    mkdirSync(path.join(root, "vendor", "intx", "log"), { recursive: true });
    writeFileSync(path.join(root, "vendor", "intx", "log", "index.ts"), "hi");
    const hash = hashDirectory(path.join(root, "vendor", "intx", "log"));
    writeFileSync(path.join(root, "vendor", "intx", "log", "index.ts"), "hI");
    const report = auditVendorDrift(
      [{ path: "@intx/log", owner: "ada", killDate: "2027-01-01", hash }],
      root,
    );
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain("@intx/log");
    expect(report.violations[0]).toContain("edited without recording it");
    expect(report.violations[0]).toContain("VENDORED-FROM delta line");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a vendored row without a valid hash column is a drift violation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "killdates-test-"));
  try {
    mkdirSync(path.join(root, "vendor", "intx", "log"), { recursive: true });
    writeFileSync(path.join(root, "vendor", "intx", "log", "index.ts"), "hi");
    const report = auditVendorDrift(
      [{ path: "@intx/log", owner: "ada", killDate: "2027-01-01" }],
      root,
    );
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain("@intx/log");
    expect(report.violations[0]).toContain("sha256 content hash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
