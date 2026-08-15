import { expect, test } from "bun:test";
import {
  auditBrowserSafeSubpaths,
  parseImportSpecifiers,
  type PackageManifest,
} from "../browser-safe-subpaths";

test("a clean subpath graph passes with a note, no violations", () => {
  const packages: PackageManifest[] = [
    {
      name: "@corbits/pkg-a",
      exports: {
        ".": "packages/pkg-a/src/index.ts",
        "./client": "packages/pkg-a/src/client.ts",
      },
    },
    {
      name: "@corbits/pkg-b",
      exports: { ".": "packages/pkg-b/src/index.ts" },
    },
  ];
  const files = new Map<string, string>([
    [
      "packages/pkg-a/src/client.ts",
      [
        `import { type } from "arktype";`,
        `import type { Secret } from "@intx/db";`,
        `import { helper } from "./helper";`,
        `import { b } from "@corbits/pkg-b";`,
      ].join("\n"),
    ],
    ["packages/pkg-a/src/helper.ts", `export const helper = 1;`],
    ["packages/pkg-b/src/index.ts", `export const b = 1;`],
  ]);

  const report = auditBrowserSafeSubpaths(
    [{ package: "@corbits/pkg-a", subpath: "./client" }],
    packages,
    files,
  );

  expect(report.violations).toEqual([]);
  expect(
    report.notes.some((note) => note.includes("@corbits/pkg-a/client")),
  ).toBe(true);
});

test("a direct server-only import is a violation naming the entry and the import", () => {
  const packages: PackageManifest[] = [
    {
      name: "@corbits/pkg-a",
      exports: { "./client": "packages/pkg-a/src/client.ts" },
    },
  ];
  const files = new Map<string, string>([
    ["packages/pkg-a/src/client.ts", `import { Hono } from "hono";`],
  ]);

  const report = auditBrowserSafeSubpaths(
    [{ package: "@corbits/pkg-a", subpath: "./client" }],
    packages,
    files,
  );

  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("@corbits/pkg-a/client");
  expect(report.violations[0]).toContain(`"hono"`);
});

test("a transitive server-only import through a relative file is a violation", () => {
  const packages: PackageManifest[] = [
    {
      name: "@corbits/pkg-a",
      exports: { "./client": "packages/pkg-a/src/client.ts" },
    },
  ];
  const files = new Map<string, string>([
    ["packages/pkg-a/src/client.ts", `export { thing } from "./inner";`],
    [
      "packages/pkg-a/src/inner.ts",
      `import postgres from "postgres";\nexport const thing = 1;`,
    ],
  ]);

  const report = auditBrowserSafeSubpaths(
    [{ package: "@corbits/pkg-a", subpath: "./client" }],
    packages,
    files,
  );

  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("@corbits/pkg-a/client");
  expect(report.violations[0]).toContain("packages/pkg-a/src/inner.ts");
  expect(report.violations[0]).toContain(`"postgres"`);
});

test("a transitive server-only import through a workspace package subpath is a violation", () => {
  const packages: PackageManifest[] = [
    {
      name: "@corbits/pkg-a",
      exports: { "./client": "packages/pkg-a/src/client.ts" },
    },
    {
      name: "@corbits/pkg-b",
      exports: { "./widget": "packages/pkg-b/src/widget.ts" },
    },
  ];
  const files = new Map<string, string>([
    [
      "packages/pkg-a/src/client.ts",
      `export { widget } from "@corbits/pkg-b/widget";`,
    ],
    [
      "packages/pkg-b/src/widget.ts",
      `import { drizzle } from "drizzle-orm";\nexport const widget = 1;`,
    ],
  ]);

  const report = auditBrowserSafeSubpaths(
    [{ package: "@corbits/pkg-a", subpath: "./client" }],
    packages,
    files,
  );

  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("drizzle-orm");
});

test("@intx/* is denylisted by prefix regardless of subpath", () => {
  const packages: PackageManifest[] = [
    {
      name: "@corbits/pkg-a",
      exports: { "./client": "packages/pkg-a/src/client.ts" },
    },
  ];
  const files = new Map<string, string>([
    [
      "packages/pkg-a/src/client.ts",
      `import { createRoutes } from "@intx/hub-api";`,
    ],
  ]);

  const report = auditBrowserSafeSubpaths(
    [{ package: "@corbits/pkg-a", subpath: "./client" }],
    packages,
    files,
  );

  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("@intx/hub-api");
});

test("a type-only import of a server-only module is not a violation", () => {
  const packages: PackageManifest[] = [
    {
      name: "@corbits/pkg-a",
      exports: { "./client": "packages/pkg-a/src/client.ts" },
    },
  ];
  const files = new Map<string, string>([
    [
      "packages/pkg-a/src/client.ts",
      `import type { Row } from "postgres";\nexport type { Row };`,
    ],
  ]);

  const report = auditBrowserSafeSubpaths(
    [{ package: "@corbits/pkg-a", subpath: "./client" }],
    packages,
    files,
  );

  expect(report.violations).toEqual([]);
});

test("an external (non-workspace) package import is an opaque leaf, not a violation", () => {
  const packages: PackageManifest[] = [
    {
      name: "@corbits/pkg-a",
      exports: { "./client": "packages/pkg-a/src/client.ts" },
    },
  ];
  const files = new Map<string, string>([
    [
      "packages/pkg-a/src/client.ts",
      `import type { Thing } from "@corbits/external-git-dep";\nexport const x = 1;`,
    ],
  ]);

  const report = auditBrowserSafeSubpaths(
    [{ package: "@corbits/pkg-a", subpath: "./client" }],
    packages,
    files,
  );

  expect(report.violations).toEqual([]);
});

test("an unresolvable relative import is reported, not silently skipped", () => {
  const packages: PackageManifest[] = [
    {
      name: "@corbits/pkg-a",
      exports: { "./client": "packages/pkg-a/src/client.ts" },
    },
  ];
  const files = new Map<string, string>([
    [
      "packages/pkg-a/src/client.ts",
      `export { missing } from "./does-not-exist";`,
    ],
  ]);

  const report = auditBrowserSafeSubpaths(
    [{ package: "@corbits/pkg-a", subpath: "./client" }],
    packages,
    files,
  );

  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("./does-not-exist");
});

test("an entry with no declared package or subpath is reported", () => {
  const report = auditBrowserSafeSubpaths(
    [{ package: "@corbits/nonexistent", subpath: "./client" }],
    [],
    new Map(),
  );
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("@corbits/nonexistent");
});

test("parseImportSpecifiers marks a whole-statement `import type` as type-only", () => {
  const specs = parseImportSpecifiers(
    `import type { X } from "postgres";\nimport { Y } from "react";`,
  );
  expect(specs).toEqual([
    { specifier: "postgres", typeOnly: true },
    { specifier: "react", typeOnly: false },
  ]);
});

test("parseImportSpecifiers treats a mixed import as a value import", () => {
  const specs = parseImportSpecifiers(`import { type X, y } from "hono";`);
  expect(specs).toEqual([{ specifier: "hono", typeOnly: false }]);
});

test("parseImportSpecifiers handles multi-line export-from lists", () => {
  const specs = parseImportSpecifiers(
    ["export {", "  a,", "  b,", '} from "./group";'].join("\n"),
  );
  expect(specs).toEqual([{ specifier: "./group", typeOnly: false }]);
});
