import { expect, test } from "bun:test";
import { auditCatalogPins } from "../catalog-pins";

test("a literal range for a catalogued dependency is a violation", () => {
  const report = auditCatalogPins({ hono: "^4.11.9" }, [
    {
      dir: "packages/inbox",
      packageJson: { dependencies: { hono: "^4.11.9" } },
    },
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("packages/inbox/package.json");
  expect(report.violations[0]).toContain("hono");
});

test("catalog: for a catalogued dependency passes", () => {
  const report = auditCatalogPins({ hono: "^4.11.9" }, [
    {
      dir: "packages/inbox",
      packageJson: { dependencies: { hono: "catalog:" } },
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("a literal for a dependency not in the catalog is fine", () => {
  const report = auditCatalogPins({ hono: "^4.11.9" }, [
    {
      dir: "packages/inbox",
      packageJson: { dependencies: { react: "^19.2.0" } },
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("checks devDependencies and peerDependencies too", () => {
  const report = auditCatalogPins({ postgres: "^3.4.8" }, [
    {
      dir: "packages/a",
      packageJson: { devDependencies: { postgres: "^3.4.8" } },
    },
    {
      dir: "packages/b",
      packageJson: { peerDependencies: { postgres: "^3.4.8" } },
    },
  ]);
  expect(report.violations).toHaveLength(2);
});
