import { expect, test } from "bun:test";
import { auditReportError } from "../report-error";

test("a catch that calls reportError passes", () => {
  const report = auditReportError([
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
  ]);
  expect(report.violations).toEqual([]);
});

test("a catch that calls reportError through a namespace import passes", () => {
  const report = auditReportError([
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
  ]);
  expect(report.violations).toEqual([]);
});

test("a catch that calls an aliased reportError import passes", () => {
  const report = auditReportError([
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
  ]);
  expect(report.violations).toEqual([]);
});

test("a catch that calls an unrelated local function named reportError is a violation", () => {
  const report = auditReportError([
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
  ]);
  expect(report.violations).toHaveLength(1);
});

test("a throw queued inside a nested callback is a violation, not a rethrow", () => {
  const report = auditReportError([
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
  ]);
  expect(report.violations).toHaveLength(1);
});

test("a catch that rethrows passes", () => {
  const report = auditReportError([
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
  ]);
  expect(report.violations).toEqual([]);
});

test("a catch that conditionally rethrows passes", () => {
  const report = auditReportError([
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
  ]);
  expect(report.violations).toEqual([]);
});

test("a bare catch {} is a violation", () => {
  const report = auditReportError([
    {
      relPath: "apps/hub/src/stream.ts",
      contents: [`try {`, `  doWork();`, `} catch {}`].join("\n"),
    },
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("apps/hub/src/stream.ts:3");
});

test("a catch that only logs, without reportError or rethrow, is a violation", () => {
  const report = auditReportError([
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
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("console.error(error)");
});

test("a catch with the opt-out marker in its body passes with a note", () => {
  const report = auditReportError([
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
  ]);
  expect(report.violations).toEqual([]);
  expect(
    report.notes.some((n) => n.includes("CL-7234 tracked separately")),
  ).toBe(true);
});

test("a catch with the opt-out marker on its own line passes", () => {
  const report = auditReportError([
    {
      relPath: "apps/hub/src/stream.ts",
      contents: [
        `try {`,
        `  doWork();`,
        `  // report-error-ignore: CL-7197 fixed by a concurrent lane`,
        `} catch {}`,
      ].join("\n"),
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("reports every violation across multiple files, not just the first", () => {
  const report = auditReportError([
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
  ]);
  expect(report.violations).toHaveLength(2);
});

test("a file with no catch clauses passes with only the summary note", () => {
  const report = auditReportError([
    { relPath: "packages/chat/src/pure.ts", contents: "export const x = 1;" },
  ]);
  expect(report.violations).toEqual([]);
  expect(report.notes).toHaveLength(1);
  expect(report.notes[0]).toContain("0 catch clause(s) scanned");
});

test("the summary note counts compliant, opted-out, and violating clauses", () => {
  const report = auditReportError([
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
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.notes.at(-1)).toContain(
    "3 catch clause(s) scanned: 1 compliant, 1 opted out, 1 violation(s)",
  );
});
