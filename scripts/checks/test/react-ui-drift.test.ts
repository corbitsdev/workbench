import { expect, test } from "bun:test";
import { auditReactUiDrift, findDriftViolations } from "../react-ui-drift";

test("a raw <table> under the snapshot count passes", () => {
  const { report, ratchetCount } = auditReactUiDrift(
    [
      {
        relPath: "apps/web/src/pages/some-page.tsx",
        contents: `<table className="x"><tbody /></table>`,
      },
    ],
    [],
    1,
  );
  expect(ratchetCount).toBe(1);
  expect(report.violations).toEqual([]);
});

test("a raw <table> over the snapshot count fails", () => {
  const { report, ratchetCount } = auditReactUiDrift(
    [
      {
        relPath: "apps/web/src/pages/some-page.tsx",
        contents: `<table className="x"><tbody /></table>`,
      },
    ],
    [],
    0,
  );
  expect(ratchetCount).toBe(1);
  expect(report.violations.length).toBeGreaterThan(0);
  expect(report.violations.some((v) => v.includes("exceeds"))).toBe(true);
});

test('role="dialog" hard-fails even when the ratchet count is under the snapshot', () => {
  const { report } = auditReactUiDrift(
    [
      {
        relPath: "apps/web/src/pages/some-page.tsx",
        contents: `<div role="dialog">hi</div>`,
      },
    ],
    [],
    1000,
  );
  expect(report.violations.some((v) => v.includes("zero-tolerance"))).toBe(
    true,
  );
});

test("aria-modal hard-fails even when the ratchet count is under the snapshot", () => {
  const { report } = auditReactUiDrift(
    [
      {
        relPath: "apps/web/src/pages/some-page.tsx",
        contents: `<div aria-modal="true">hi</div>`,
      },
    ],
    [],
    1000,
  );
  expect(report.violations.some((v) => v.includes("zero-tolerance"))).toBe(
    true,
  );
});

test("a raw <select>/<textarea>/radio/checkbox is flagged as raw-form-control", () => {
  const violations = findDriftViolations([
    {
      relPath: "packages/settings-ui/src/x.tsx",
      contents: [
        `<select value={v} />`,
        `<textarea value={v} />`,
        `<input type="radio" />`,
        `<input type="checkbox" />`,
      ].join("\n"),
    },
  ]);
  expect(
    violations.filter((v) => v.driftClass === "raw-form-control"),
  ).toHaveLength(4);
});

test("an allowlisted file's raw-form-control and raw-button hits don't count toward the ratchet", () => {
  const files = [
    {
      relPath: "packages/tasks-ui/src/legacy-form.tsx",
      contents: `<select value={v} /><button className="x">Go</button>`,
    },
  ];
  const { ratchetCount } = auditReactUiDrift(
    files,
    [{ relPath: "packages/tasks-ui/src/legacy-form.tsx", ticket: "CL-0000" }],
    0,
  );
  expect(ratchetCount).toBe(0);
});

test("a raw <table> in an allowlisted file still counts — class (b) has no exclusion", () => {
  const files = [
    {
      relPath: "packages/tasks-ui/src/legacy-form.tsx",
      contents: `<table className="x" />`,
    },
  ];
  const { ratchetCount } = auditReactUiDrift(
    files,
    [{ relPath: "packages/tasks-ui/src/legacy-form.tsx", ticket: "CL-0000" }],
    0,
  );
  expect(ratchetCount).toBe(1);
});

test("a raw <button> with no className is not a violation", () => {
  const violations = findDriftViolations([
    {
      relPath: "apps/web/src/x.tsx",
      contents: `<button type="button" onClick={fn}>Go</button>`,
    },
  ]);
  expect(violations).toEqual([]);
});

test("a raw <button> with className in a file that imports Button from react-ui is not a violation", () => {
  const violations = findDriftViolations([
    {
      relPath: "apps/web/src/x.tsx",
      contents: [
        `import { Button } from "@corbits/react-ui";`,
        `export const X = () => <button className="x">Go</button>;`,
      ].join("\n"),
    },
  ]);
  expect(violations).toEqual([]);
});

test("a raw <button> with className in a file that imports an unrelated react-ui export is a violation", () => {
  const violations = findDriftViolations([
    {
      relPath: "apps/web/src/x.tsx",
      contents: [
        `import { Badge } from "@corbits/react-ui";`,
        `export const X = () => <button className="x">Go</button>;`,
      ].join("\n"),
    },
  ]);
  expect(violations).toHaveLength(1);
  expect(violations[0]?.driftClass).toBe("raw-button");
});

test("a file importing a Button-like export other than Button itself (e.g. ConfirmButton) is exempt", () => {
  const violations = findDriftViolations([
    {
      relPath: "apps/web/src/x.tsx",
      contents: [
        `import { ConfirmButton } from "@corbits/react-ui";`,
        `export const X = () => <button className="x">Go</button>;`,
      ].join("\n"),
    },
  ]);
  expect(violations).toEqual([]);
});
