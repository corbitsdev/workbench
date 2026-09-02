import { expect, test } from "bun:test";
import { auditLocalErrorEnvelopeFactories } from "../error-envelope";

test("clean files pass with no violations", () => {
  const report = auditLocalErrorEnvelopeFactories([
    {
      relPath: "packages/onboarding/src/provision.ts",
      contents: "export const x = 1;",
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("an arrow ErrorEnvelope factory is a violation naming the file", () => {
  const report = auditLocalErrorEnvelopeFactories([
    {
      relPath: "packages/insights/src/routes.ts",
      contents: `const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});`,
    },
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("packages/insights/src/routes.ts");
  expect(report.violations[0]).toContain("makeErrorEnvelope");
});

test("a function errorEnvelope factory is a violation naming the file", () => {
  const report = auditLocalErrorEnvelopeFactories([
    {
      relPath: "packages/skills/src/routes.ts",
      contents: `function errorEnvelope(code: string, message: string) {
  return { error: { code, message } };
}`,
    },
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("packages/skills/src/routes.ts");
});

test("an arktype parser named ErrorEnvelope is not a factory", () => {
  const report = auditLocalErrorEnvelopeFactories([
    {
      relPath: "packages/settings-ui/src/api-request.ts",
      contents: `const ErrorEnvelope = type({
  error: { message: "string", "code?": "string" },
});`,
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("a comment that mentions the old envelope is not a violation", () => {
  const report = auditLocalErrorEnvelopeFactories([
    {
      relPath: "packages/onboarding/src/provision.ts",
      contents:
        "// the same `{ error: { code, message } }` envelope every other hub route uses",
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("makeErrorEnvelope usage is not a violation", () => {
  const report = auditLocalErrorEnvelopeFactories([
    {
      relPath: "packages/sidecar-placement/src/routes.ts",
      contents: `import { makeErrorEnvelope } from "@corbits/error-sink";
return c.json(makeErrorEnvelope({ code: "bad_request", userMessage: "no" }), 400);`,
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("reports every violation across multiple files, not just the first", () => {
  const report = auditLocalErrorEnvelopeFactories([
    {
      relPath: "a.ts",
      contents: `const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});`,
    },
    {
      relPath: "b.ts",
      contents: `function errorEnvelope(code: string, message: string) {
  return { error: { code, message } };
}`,
    },
    { relPath: "c.ts", contents: "clean" },
  ]);
  expect(report.violations).toHaveLength(2);
});

test("allowlisted files that wrap makeErrorEnvelope pass", () => {
  const report = auditLocalErrorEnvelopeFactories([
    {
      relPath: "packages/onboarding/src/routes.ts",
      contents: `function reportOnboardingError() {
  return makeErrorEnvelope({ code: "x", userMessage: "y", refId: "z" });
}`,
    },
    {
      relPath: "packages/error-sink/src/error-envelope.ts",
      contents: `export function makeErrorEnvelope(args: {
  code: string;
  userMessage: string;
  refId?: string;
}) {
  return { error: { code: args.code, userMessage: args.userMessage, refId: "x" } };
}`,
    },
  ]);
  expect(report.violations).toEqual([]);
  expect(
    report.notes.some((n) => n.includes("packages/onboarding/src/routes.ts")),
  ).toBe(true);
});
