import { expect, test } from "bun:test";

import { parseReviewerReport } from "./report";

test("parses a bare JSON report", () => {
  const parsed = parseReviewerReport(
    '{"summary":"read the diff","findings":[{"severity":"blocking",' +
      '"file":"src/loop.ts","line":2,"summary":"drops the second pass"}]}',
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(parsed.report.findings[0]?.severity).toBe("blocking");
  expect(parsed.report.findings[0]?.line).toBe(2);
});

test("parses a report inside a JSON code fence", () => {
  const parsed = parseReviewerReport(
    '```json\n{"summary":"fine","findings":[]}\n```',
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(parsed.report.findings).toEqual([]);
});

test("an empty findings list is a real report, not a failure", () => {
  const parsed = parseReviewerReport(
    '{"summary":"genuinely fine","findings":[]}',
  );
  expect(parsed.ok).toBe(true);
});

test("prose instead of JSON comes back as a named failure", () => {
  const parsed = parseReviewerReport("Looks good to me!");
  expect(parsed).toEqual({ ok: false, reason: "the reply was not JSON" });
});

test("an empty reply comes back as a named failure", () => {
  expect(parseReviewerReport("   ")).toEqual({
    ok: false,
    reason: "the reply was empty",
  });
});

test("a wrong severity is rejected rather than coerced", () => {
  const parsed = parseReviewerReport(
    '{"summary":"x","findings":[{"severity":"nit","file":"a.ts",' +
      '"summary":"style"}]}',
  );
  expect(parsed.ok).toBe(false);
});

test("existingCode and suggestedFix parse as a before/after code pair", () => {
  const parsed = parseReviewerReport(
    '{"summary":"x","findings":[{"severity":"blocking","file":"a.ts",' +
      '"line":2,"summary":"off by one","existingCode":"for (let i = 0; ' +
      'i <= n; i++) {","suggestedFix":"for (let i = 0; i < n; i++) {"}]}',
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(parsed.report.findings[0]?.existingCode).toBe(
    "for (let i = 0; i <= n; i++) {",
  );
  expect(parsed.report.findings[0]?.suggestedFix).toBe(
    "for (let i = 0; i < n; i++) {",
  );
});
