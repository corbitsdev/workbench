import { describe, expect, test } from "bun:test";

import {
  formatSummary,
  mergeCoverage,
  parseLcov,
  shouldExclude,
  summarize,
} from "./coverage-merge.ts";

const LCOV_A = `TN:
SF:src/index.ts
FNF:2
FNH:2
DA:1,5
DA:2,5
DA:3,0
LF:3
LH:2
end_of_record
`;

// Same file as A (cross-workspace import) plus a workspace-local file. Line 3 of
// index.ts is hit here but not in A — the union must count it as covered.
const LCOV_B = `TN:
SF:../a/src/index.ts
DA:1,1
DA:2,0
DA:3,4
end_of_record
SF:src/local.ts
DA:1,0
DA:2,0
end_of_record
`;

const LCOV_VENDOR = `TN:
SF:../../interchange/packages/types/src/runtime.ts
DA:1,0
DA:2,0
end_of_record
`;

describe("parseLcov", () => {
  test("extracts per-file DA line/count pairs", () => {
    const files = parseLcov(LCOV_A);
    expect(files).toEqual([
      {
        file: "src/index.ts",
        lines: [
          [1, 5],
          [2, 5],
          [3, 0],
        ],
      },
    ]);
  });

  test("parses multiple records", () => {
    expect(parseLcov(LCOV_B)).toHaveLength(2);
  });

  test("ignores empty input", () => {
    expect(parseLcov("")).toEqual([]);
  });
});

describe("shouldExclude", () => {
  test("excludes interchange, node_modules, and test files", () => {
    expect(
      shouldExclude("/repo/interchange/packages/types/src/runtime.ts"),
    ).toBe(true);
    expect(shouldExclude("/repo/node_modules/foo/index.js")).toBe(true);
    expect(shouldExclude("/repo/packages/a/src/index.test.ts")).toBe(true);
    expect(shouldExclude("/repo/packages/a/src/index.spec.ts")).toBe(true);
  });

  test("keeps first-party source files", () => {
    expect(shouldExclude("/repo/packages/a/src/index.ts")).toBe(false);
  });
});

describe("mergeCoverage", () => {
  test("unions line hits for the same file across workspaces", () => {
    const merged = mergeCoverage([
      { baseDir: "/repo/packages/a", content: LCOV_A },
      { baseDir: "/repo/packages/b", content: LCOV_B },
    ]);
    // ../a/src/index.ts from baseDir /repo/packages/b resolves to the same
    // absolute path as src/index.ts from /repo/packages/a — one entry.
    const idx = merged.get("/repo/packages/a/src/index.ts");
    expect(idx).toBeDefined();
    // Line 3 was 0 in A and 4 in B -> covered.
    expect(idx?.get(3)).toBe(4);
    expect(merged.has("/repo/packages/b/src/local.ts")).toBe(true);
  });

  test("drops vendored and excluded files", () => {
    const merged = mergeCoverage([
      { baseDir: "/repo/apps/hub", content: LCOV_VENDOR },
    ]);
    expect(merged.size).toBe(0);
  });
});

describe("summarize", () => {
  test("counts distinct instrumented lines and union hits", () => {
    const merged = mergeCoverage([
      { baseDir: "/repo/packages/a", content: LCOV_A },
      { baseDir: "/repo/packages/b", content: LCOV_B },
    ]);
    const summary = summarize(merged);
    // index.ts: 3 lines, all covered via union. local.ts: 2 lines, 0 covered.
    expect(summary.linesFound).toBe(5);
    expect(summary.linesHit).toBe(3);
    expect(summary.linePct).toBeCloseTo(60, 5);
  });

  test("reports 100% when nothing is instrumented", () => {
    const summary = summarize(new Map());
    expect(summary.linePct).toBe(100);
    expect(summary.linesFound).toBe(0);
  });
});

describe("formatSummary", () => {
  test("renders the line percentage and counts", () => {
    const summary = summarize(
      mergeCoverage([{ baseDir: "/repo/packages/a", content: LCOV_A }]),
    );
    const out = formatSummary(summary);
    expect(out).toContain("66.67%");
    expect(out).toContain("2/3");
  });
});
