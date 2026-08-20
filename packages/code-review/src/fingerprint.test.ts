import { expect, test } from "bun:test";

import {
  fingerprintMarker,
  fingerprintOf,
  fingerprintsIn,
} from "./fingerprint";
import type { ReviewerFinding } from "./report";

function finding(overrides: Partial<ReviewerFinding> = {}): ReviewerFinding {
  return {
    severity: "blocking",
    file: "src/loop.ts",
    line: 2,
    summary: "Drops the second pass",
    ...overrides,
  };
}

test("the same finding fingerprints the same way every time", () => {
  expect(fingerprintOf(finding())).toBe(fingerprintOf(finding()));
});

test("whitespace and case in the summary do not change the fingerprint", () => {
  expect(fingerprintOf(finding({ summary: "drops the  second pass  " }))).toBe(
    fingerprintOf(finding({ summary: "Drops the second pass" })),
  );
});

test("a different line changes the fingerprint", () => {
  expect(fingerprintOf(finding({ line: 3 }))).not.toBe(
    fingerprintOf(finding({ line: 2 })),
  );
});

test("a different file changes the fingerprint", () => {
  expect(fingerprintOf(finding({ file: "other.ts" }))).not.toBe(
    fingerprintOf(finding()),
  );
});

test("fingerprintsIn reads every marker out of posted comment bodies", () => {
  const a = fingerprintOf(finding());
  const b = fingerprintOf(finding({ file: "other.ts" }));
  const found = fingerprintsIn([
    `Some text\n\n${fingerprintMarker(a)}`,
    `Other text ${fingerprintMarker(b)} trailing`,
    "No marker here.",
  ]);
  expect(found).toEqual(new Set([a, b]));
});

test("fingerprintsIn ignores text that only looks like a marker", () => {
  expect(fingerprintsIn(["<!-- code-review:finding:not-a-hash -->"])).toEqual(
    new Set(),
  );
});
