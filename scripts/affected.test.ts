import { describe, expect, test } from "bun:test";

import {
  affectedPackages,
  directlyChanged,
  isGlobalChange,
  ownerOf,
  withDependents,
  type PackageManifest,
} from "./affected.ts";

const manifests: PackageManifest[] = [
  { name: "@corbits/events", dir: "packages/events", workspaceDeps: [] },
  {
    name: "@corbits/chat",
    dir: "packages/chat",
    workspaceDeps: ["@corbits/events"],
  },
  {
    name: "@workbench/hub",
    dir: "apps/hub",
    workspaceDeps: ["@corbits/chat"],
  },
  { name: "@corbits/slug", dir: "packages/slug", workspaceDeps: [] },
  { name: "@intx/db", dir: "vendor/intx/db", workspaceDeps: [] },
];

describe("isGlobalChange", () => {
  test("a root manifest or shared tsconfig forces a full run", () => {
    expect(isGlobalChange(["package.json"])).toBe(true);
    expect(isGlobalChange(["tsconfig.base.json"])).toBe(true);
  });

  test("anything under scripts/ forces a full run, since the gate itself moved", () => {
    expect(isGlobalChange(["scripts/run-all.ts"])).toBe(true);
  });

  test("a package-local manifest is not global", () => {
    expect(isGlobalChange(["packages/chat/package.json"])).toBe(false);
  });

  test("ordinary source changes are not global", () => {
    expect(isGlobalChange(["packages/chat/src/index.ts"])).toBe(false);
  });
});

describe("ownerOf", () => {
  test("attributes a file to its package", () => {
    expect(ownerOf("packages/chat/src/index.ts", manifests)).toBe(
      "@corbits/chat",
    );
  });

  test("prefers the longest matching root so a nested workspace is not shadowed", () => {
    expect(ownerOf("vendor/intx/db/src/schema.ts", manifests)).toBe("@intx/db");
  });

  test("returns undefined for a file no package owns", () => {
    expect(ownerOf("README.md", manifests)).toBeUndefined();
  });
});

describe("directlyChanged", () => {
  test("collects each touched package once", () => {
    const changed = directlyChanged(
      [
        "packages/chat/src/a.ts",
        "packages/chat/src/b.ts",
        "packages/slug/src/c.ts",
      ],
      manifests,
    );
    expect([...changed].sort()).toEqual(["@corbits/chat", "@corbits/slug"]);
  });
});

describe("withDependents", () => {
  test("pulls in transitive dependents, not just direct ones", () => {
    const affected = withDependents(new Set(["@corbits/events"]), manifests);
    expect([...affected].sort()).toEqual([
      "@corbits/chat",
      "@corbits/events",
      "@workbench/hub",
    ]);
  });

  test("a leaf package affects only itself", () => {
    expect([...withDependents(new Set(["@corbits/slug"]), manifests)]).toEqual([
      "@corbits/slug",
    ]);
  });

  test("terminates on a dependency cycle", () => {
    const cyclic: PackageManifest[] = [
      { name: "a", dir: "packages/a", workspaceDeps: ["b"] },
      { name: "b", dir: "packages/b", workspaceDeps: ["a"] },
    ];
    expect([...withDependents(new Set(["a"]), cyclic)].sort()).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("affectedPackages", () => {
  test("a global change returns 'all' rather than a filtered set", () => {
    expect(affectedPackages(["bun.lock"], manifests)).toBe("all");
  });

  test("a package change returns that package and everything above it", () => {
    const affected = affectedPackages(
      ["packages/events/src/parse.ts"],
      manifests,
    );
    expect(affected).not.toBe("all");
    expect([...(affected as Set<string>)].sort()).toEqual([
      "@corbits/chat",
      "@corbits/events",
      "@workbench/hub",
    ]);
  });

  test("a change owned by no package checks nothing", () => {
    expect([
      ...(affectedPackages(["docs/GLOSSARY.md"], manifests) as Set<string>),
    ]).toEqual([]);
  });
});
