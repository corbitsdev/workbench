import { expect, test } from "bun:test";
import { collectExportTargets, declaredDependencyNames } from "../lib/exports";
import {
  auditVendoredLedger,
  tarballNameFor,
  vendoredLedgerPaths,
} from "../packages";

test("tarballNameFor flattens a scoped name the way bun pm pack does", () => {
  expect(tarballNameFor("@workbench/echo", "0.0.1")).toBe(
    "workbench-echo-0.0.1.tgz",
  );
  expect(tarballNameFor("plain", "1.2.3")).toBe("plain-1.2.3.tgz");
});

test("collectExportTargets gathers every promised relative file once", () => {
  const targets = collectExportTargets({
    ".": { bun: "./src/index.ts", default: "./src/index.ts" },
    "./extra": "./src/extra.ts",
  });
  expect(targets.sort()).toEqual(["./src/extra.ts", "./src/index.ts"]);
});

test("declaredDependencyNames reads dependencies only", () => {
  expect(
    declaredDependencyNames({
      dependencies: { arktype: "catalog:" },
      devDependencies: { typescript: "catalog:" },
    }),
  ).toEqual(["arktype"]);
  expect(declaredDependencyNames({})).toEqual([]);
});

test("vendoredLedgerPaths reads backticked paths from ledger rows only", () => {
  const markdown = [
    "| Vendored path | What was copied |",
    "| ------------- | --------------- |",
    "| `vendor/intx/log` | `@intx/log` source |",
    "| `vendor/intx/agent` | `@intx/agent` source |",
    "Prose mentioning `vendor/intx/other` is not a row.",
  ].join("\n");
  expect(vendoredLedgerPaths(markdown)).toEqual([
    "vendor/intx/log",
    "vendor/intx/agent",
  ]);
});

test("a vendored directory with no ledger row is a violation", () => {
  const report = auditVendoredLedger(["vendor/intx/log"], [], () => true);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("vendor/intx/log");
  expect(report.violations[0]).toContain("no VENDORED.md ledger row");
});

test("a ledger row whose path no longer exists is a violation", () => {
  const report = auditVendoredLedger([], ["vendor/intx/log"], () => false);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain('"vendor/intx/log"');
  expect(report.violations[0]).toContain("no longer exists");
});

test("a vendored directory matched by a ledger row passes", () => {
  const report = auditVendoredLedger(
    ["vendor/intx/log"],
    ["vendor/intx/log"],
    (ledgerPath) => ledgerPath === "vendor/intx/log",
  );
  expect(report.violations).toEqual([]);
});

test("a ledger row outside vendor/ passes when its path exists", () => {
  const report = auditVendoredLedger(
    [],
    ["apps/sidecar"],
    (ledgerPath) => ledgerPath === "apps/sidecar",
  );
  expect(report.violations).toEqual([]);
});
