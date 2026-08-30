import { expect, test } from "bun:test";
import {
  auditReportError,
  baselineKey,
  parseBaseline,
  parseChangedRanges,
  serializeBaseline,
} from "../report-error";

const NO_BASELINE = { baseline: new Set<string>() };
const BASELINE_REGENERATE_HINT = "--write-baseline";

test("a catch that calls reportError passes", () => {
  const report = auditReportError(
    [
      {
        relPath: "packages/chat/src/thing.ts",
        contents: [
          `import { reportError } from "@corbits/error-sink";`,
          `try {`,
          `  doWork();`,
          `} catch (error) {`,
          `  reportError(error, { operation: "thing" });`,
          `}`,
        ].join("\n"),
      },
    ],
    NO_BASELINE,
  );
  expect(report.violations).toEqual([]);
});

test("a catch that calls reportError through a namespace import passes", () => {
  const report = auditReportError(
    [
      {
        relPath: "packages/chat/src/thing.ts",
        contents: [
          `import * as errorSink from "@corbits/error-sink";`,
          `try {`,
          `  doWork();`,
          `} catch (error) {`,
          `  errorSink.reportError(error, { operation: "thing" });`,
          `}`,
        ].join("\n"),
      },
    ],
    NO_BASELINE,
  );
  expect(report.violations).toEqual([]);
});

test("a catch that calls an aliased reportError import passes", () => {
  const report = auditReportError(
    [
      {
        relPath: "packages/chat/src/thing.ts",
        contents: [
          `import { reportError as report } from "@corbits/error-sink";`,
          `try {`,
          `  doWork();`,
          `} catch (error) {`,
          `  report(error, { operation: "thing" });`,
          `}`,
        ].join("\n"),
      },
    ],
    NO_BASELINE,
  );
  expect(report.violations).toEqual([]);
});

test("a catch that calls an unrelated local function named reportError is a violation", () => {
  const report = auditReportError(
    [
      {
        relPath: "packages/chat/src/thing.ts",
        contents: [
          `function reportError(message: string) {`,
          `  console.log(message);`,
          `}`,
          `try {`,
          `  doWork();`,
          `} catch (error) {`,
          `  reportError("failed");`,
          `}`,
        ].join("\n"),
      },
    ],
    NO_BASELINE,
  );
  expect(report.violations).toHaveLength(1);
});

test("a throw queued inside a nested callback is a violation, not a rethrow", () => {
  const report = auditReportError(
    [
      {
        relPath: "apps/hub/src/stream.ts",
        contents: [
          `try {`,
          `  doWork();`,
          `} catch (error) {`,
          `  setTimeout(() => {`,
          `    throw error;`,
          `  }, 0);`,
          `}`,
        ].join("\n"),
      },
    ],
    NO_BASELINE,
  );
  expect(report.violations).toHaveLength(1);
});

test("a catch that rethrows passes", () => {
  const report = auditReportError(
    [
      {
        relPath: "packages/chat/src/thing.ts",
        contents: [
          `try {`,
          `  doWork();`,
          `} catch (error) {`,
          `  throw error;`,
          `}`,
        ].join("\n"),
      },
    ],
    NO_BASELINE,
  );
  expect(report.violations).toEqual([]);
});

test("a catch that conditionally rethrows passes", () => {
  const report = auditReportError(
    [
      {
        relPath: "packages/chat/src/thing.ts",
        contents: [
          `try {`,
          `  doWork();`,
          `} catch (error) {`,
          `  if (isFatal(error)) throw error;`,
          `  cache.clear();`,
          `}`,
        ].join("\n"),
      },
    ],
    NO_BASELINE,
  );
  expect(report.violations).toEqual([]);
});

test("a bare catch {} is a violation", () => {
  const report = auditReportError(
    [
      {
        relPath: "apps/hub/src/stream.ts",
        contents: [`try {`, `  doWork();`, `} catch {}`].join("\n"),
      },
    ],
    NO_BASELINE,
  );
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("apps/hub/src/stream.ts:3");
});

test("a catch that only logs, without reportError or rethrow, is a violation", () => {
  const report = auditReportError(
    [
      {
        relPath: "packages/onboarding/src/routes.ts",
        contents: [
          `try {`,
          `  doWork();`,
          `} catch (error) {`,
          `  console.error(error);`,
          `}`,
        ].join("\n"),
      },
    ],
    NO_BASELINE,
  );
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("console.error(error)");
});

test("a catch with the opt-out marker in its body passes with a note", () => {
  const report = auditReportError(
    [
      {
        relPath: "packages/onboarding/src/plant-env-credentials.ts",
        contents: [
          `try {`,
          `  doWork();`,
          `} catch (error) {`,
          `  // report-error-ignore: CL-7234 tracked separately`,
          `  console.error(error);`,
          `}`,
        ].join("\n"),
      },
    ],
    NO_BASELINE,
  );
  expect(report.violations).toEqual([]);
  expect(
    report.notes.some((n) => n.includes("CL-7234 tracked separately")),
  ).toBe(true);
});

test("a catch with the opt-out marker on its own line passes", () => {
  const report = auditReportError(
    [
      {
        relPath: "apps/hub/src/stream.ts",
        contents: [
          `try {`,
          `  doWork();`,
          `  // report-error-ignore: CL-7197 fixed by a concurrent lane`,
          `} catch {}`,
        ].join("\n"),
      },
    ],
    NO_BASELINE,
  );
  expect(report.violations).toEqual([]);
});

test("an opted-out catch is never a candidate for the baseline", () => {
  // Even with an empty baseline, a ticketed opt-out never appears as a
  // "new finding" violation — it's a separate mechanism entirely.
  const report = auditReportError(
    [
      {
        relPath: "apps/hub/src/stream.ts",
        contents: [
          `try {`,
          `  doWork();`,
          `  // report-error-ignore: CL-7197 fixed by a concurrent lane`,
          `} catch {}`,
        ].join("\n"),
      },
    ],
    {
      baseline: new Set(),
      changedLines: new Map([
        ["apps/hub/src/stream.ts", [{ start: 1, end: 4 }]],
      ]),
    },
  );
  expect(report.violations).toEqual([]);
});

test("reports every violation across multiple files, not just the first", () => {
  const report = auditReportError(
    [
      {
        relPath: "a.ts",
        contents: [`try {`, `  x();`, `} catch {}`].join("\n"),
      },
      {
        relPath: "b.ts",
        contents: [`try {`, `  x();`, `} catch {}`].join("\n"),
      },
      {
        relPath: "c.ts",
        contents: [
          `import { reportError } from "@corbits/error-sink";`,
          `try {`,
          `  x();`,
          `} catch (e) {`,
          `  reportError(e, {});`,
          `}`,
        ].join("\n"),
      },
    ],
    NO_BASELINE,
  );
  expect(report.violations).toHaveLength(2);
});

test("a file with no catch clauses passes with only the summary note", () => {
  const report = auditReportError(
    [{ relPath: "packages/chat/src/pure.ts", contents: "export const x = 1;" }],
    NO_BASELINE,
  );
  expect(report.violations).toEqual([]);
  expect(report.notes).toHaveLength(1);
  expect(report.notes[0]).toContain("0 catch clause(s) scanned");
});

test("the summary note counts compliant, opted-out, baselined, new, and stale entries", () => {
  const report = auditReportError(
    [
      {
        relPath: "a.ts",
        contents: [
          `import { reportError } from "@corbits/error-sink";`,
          `try {`,
          `  x();`,
          `} catch (e) {`,
          `  reportError(e, {});`,
          `}`,
        ].join("\n"),
      },
      {
        relPath: "b.ts",
        contents: [
          `try {`,
          `  x();`,
          `  // report-error-ignore: CL-0000 example`,
          `} catch {}`,
        ].join("\n"),
      },
      {
        relPath: "c.ts",
        contents: [`try {`, `  x();`, `} catch {}`].join("\n"),
      },
    ],
    NO_BASELINE,
  );
  expect(report.violations).toHaveLength(1);
  expect(report.notes.at(-1)).toContain(
    "3 catch clause(s) scanned: 1 compliant, 1 opted out, 0 baselined " +
      "pre-existing, 1 new finding(s), 0 stale baseline entrie(s)",
  );
});

test("a finding already in the baseline passes when its file isn't touched", () => {
  const evidence = "return null;";
  const key = baselineKey("c.ts", 1, evidence);
  const report = auditReportError(
    [
      {
        relPath: "c.ts",
        contents: [`try {`, `  x();`, `} catch {`, `  return null;`, `}`].join(
          "\n",
        ),
      },
    ],
    { baseline: new Set([key]) },
  );
  expect(report.violations).toEqual([]);
});

test("a finding not in the baseline is a new violation even with other entries present", () => {
  const report = auditReportError(
    [
      {
        relPath: "c.ts",
        contents: [`try {`, `  x();`, `} catch {`, `  return null;`, `}`].join(
          "\n",
        ),
      },
      {
        relPath: "other.ts",
        contents: [`try {`, `  x();`, `} catch {`, `  return null;`, `}`].join(
          "\n",
        ),
      },
    ],
    { baseline: new Set([baselineKey("other.ts", 1, "return null;")]) },
  );
  // other.ts's finding matches the baseline and passes; c.ts's identical
  // evidence in a different, non-baselined file still fails as new.
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("c.ts");
});

test("a baselined finding whose line the diff touches still fails, forcing cleanup", () => {
  const evidence = "return null;";
  const key = baselineKey("c.ts", 1, evidence);
  const report = auditReportError(
    [
      {
        relPath: "c.ts",
        contents: [`try {`, `  x();`, `} catch {`, `  return null;`, `}`].join(
          "\n",
        ),
      },
    ],
    {
      baseline: new Set([key]),
      changedLines: new Map([["c.ts", [{ start: 3, end: 3 }]]]),
    },
  );
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("diff touches this catch");
});

test("a baselined finding elsewhere in a touched file passes — the ratchet is line-scoped, not file-scoped", () => {
  const evidence = "return null;";
  const key = baselineKey("c.ts", 1, evidence);
  const report = auditReportError(
    [
      {
        relPath: "c.ts",
        contents: [`try {`, `  x();`, `} catch {`, `  return null;`, `}`].join(
          "\n",
        ),
      },
    ],
    {
      baseline: new Set([key]),
      // The diff touches line 20 of this file, nowhere near the catch on
      // line 3 — exactly this check's own case of adding an unrelated
      // report-error-ignore comment elsewhere in a debt-carrying file.
      changedLines: new Map([["c.ts", [{ start: 20, end: 21 }]]]),
    },
  );
  expect(report.violations).toEqual([]);
});

test("a stale baseline entry with no matching finding fails", () => {
  const report = auditReportError(
    [{ relPath: "c.ts", contents: "export const x = 1;" }],
    { baseline: new Set([baselineKey("c.ts", 1, "return null;")]) },
  );
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("stale entry");
  expect(report.violations[0]).toContain(BASELINE_REGENERATE_HINT);
});

test("fixing one of two identical-evidence findings in a file doesn't false-pass the other", () => {
  // Both catches share the same evidence text; the second must key
  // differently from the first so removing one doesn't silently drop
  // baseline coverage for the other.
  const contents = [
    `try {`,
    `  a();`,
    `} catch {`,
    `  return null;`,
    `}`,
    `try {`,
    `  b();`,
    `} catch {`,
    `  return null;`,
    `}`,
  ].join("\n");
  const report = auditReportError([{ relPath: "c.ts", contents }], {
    baseline: new Set([baselineKey("c.ts", 1, "return null;")]),
  });
  expect(report.violations).toHaveLength(1);
});

test("parseBaseline ignores comments and blank lines", () => {
  const text = [
    "# a comment",
    "",
    "a.ts\t1\treturn null;",
    "  ",
    "b.ts\t1\treturn undefined;",
  ].join("\n");
  const keys = parseBaseline(text);
  expect(keys).toEqual(
    new Set(["a.ts\t1\treturn null;", "b.ts\t1\treturn undefined;"]),
  );
});

test("serializeBaseline sorts entries and includes the debt-ledger header", () => {
  const text = serializeBaseline(["b.ts\t1\tx", "a.ts\t1\ty"]);
  expect(text).toContain("debt ledger — NOT an allowlist");
  expect(text).toContain("--write-baseline");
  const body = text
    .split("\n")
    .filter((line) => !line.startsWith("#") && line.trim().length > 0);
  expect(body).toEqual(["a.ts\t1\ty", "b.ts\t1\tx"]);
});

test("parseChangedRanges extracts each file's added/context line ranges from a zero-context diff", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "index 1111111..2222222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -10,0 +11,2 @@ function f() {",
    "+  line11();",
    "+  line12();",
    "diff --git a/b.ts b/b.ts",
    "index 3333333..4444444 100644",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -5 +5 @@ function g() {",
    "-old();",
    "+new();",
  ].join("\n");
  const ranges = parseChangedRanges(diff);
  expect(ranges.get("a.ts")).toEqual([{ start: 11, end: 12 }]);
  expect(ranges.get("b.ts")).toEqual([{ start: 5, end: 5 }]);
});

test("parseChangedRanges skips a pure-deletion hunk, which touches nothing in the new file", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -5,2 +4,0 @@ function f() {",
    "-removed1();",
    "-removed2();",
  ].join("\n");
  const ranges = parseChangedRanges(diff);
  expect(ranges.get("a.ts") ?? []).toEqual([]);
});
