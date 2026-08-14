import { expect, test } from "bun:test";
import {
  APP_LICENSE,
  LIBRARY_LICENSE,
  auditAppLicenses,
  auditLibraryLicenses,
  type WorkspacePackage,
} from "../licenses";

function pkg(dir: string, license: string | undefined): WorkspacePackage {
  return { dir, packageJson: { license } };
}

test("a library declaring the LGPL license with a matching LICENSE file passes", () => {
  const report = auditLibraryLicenses(
    [pkg("packages/chat", LIBRARY_LICENSE)],
    "canonical text",
    () => "canonical text",
  );
  expect(report.violations).toEqual([]);
});

test("a library with the wrong license field is a violation naming the package", () => {
  const report = auditLibraryLicenses(
    [pkg("packages/chat", "MIT")],
    "canonical text",
    () => "canonical text",
  );
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("packages/chat/package.json");
  expect(report.violations[0]).toContain('"MIT"');
  expect(report.violations[0]).toContain(LIBRARY_LICENSE);
});

test("a library missing a LICENSE file is a violation", () => {
  const report = auditLibraryLicenses(
    [pkg("workflows/echo", LIBRARY_LICENSE)],
    "canonical text",
    () => null,
  );
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("workflows/echo");
  expect(report.violations[0]).toContain("missing a LICENSE file");
});

test("a library whose LICENSE file drifts from the canonical text is a violation", () => {
  const report = auditLibraryLicenses(
    [pkg("packages/chat", LIBRARY_LICENSE)],
    "canonical text",
    () => "some other text",
  );
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("packages/chat/LICENSE");
  expect(report.violations[0]).toContain("does not match");
});

test("a library failing both checks reports both violations", () => {
  const report = auditLibraryLicenses(
    [pkg("packages/chat", "MIT")],
    "canonical text",
    () => null,
  );
  expect(report.violations).toHaveLength(2);
});

test("an app declaring the root license reference passes", () => {
  const report = auditAppLicenses([pkg("apps/web", APP_LICENSE)]);
  expect(report.violations).toEqual([]);
});

test("an app with the wrong license field is a violation naming the app", () => {
  const report = auditAppLicenses([pkg("apps/web", LIBRARY_LICENSE)]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("apps/web/package.json");
  expect(report.violations[0]).toContain(APP_LICENSE);
});

test("an app with no license field at all is a violation", () => {
  const report = auditAppLicenses([pkg("apps/web", undefined)]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("undefined");
});
