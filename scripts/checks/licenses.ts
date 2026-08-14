// check:licenses — the dual-license scheme.
//
// Every packages/* and workflows/* library is LGPL-2.1-or-later with a
// LICENSE file carrying the canonical text; every apps/* application
// points at the root GPLv2-with-AI-Exception license instead. This
// check fails when a package.json's "license" field or a library's
// LICENSE file drifts from that scheme.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

export const LIBRARY_LICENSE = "LGPL-2.1-or-later";
export const APP_LICENSE = "SEE LICENSE IN ../../LICENSE.md";
export const CANONICAL_LICENSE_TEXT_PATH = "vendor/intx/LICENSE";

interface PackageJson {
  license?: string;
}

export interface WorkspacePackage {
  /** Directory relative to the root, e.g. packages/chat. */
  dir: string;
  packageJson: PackageJson;
}

async function listPackages(
  root: string,
  pattern: string,
): Promise<WorkspacePackage[]> {
  const glob = new Glob(pattern);
  const packages: WorkspacePackage[] = [];
  for await (const manifestPath of glob.scan(root)) {
    packages.push({
      dir: path.dirname(manifestPath),
      packageJson: (await Bun.file(
        path.join(root, manifestPath),
      ).json()) as PackageJson,
    });
  }
  return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}

export function listLibraryPackages(root: string): Promise<WorkspacePackage[]> {
  return listPackages(root, "{packages,workflows}/*/package.json");
}

export function listAppPackages(root: string): Promise<WorkspacePackage[]> {
  return listPackages(root, "apps/*/package.json");
}

/**
 * Every library declares LGPL-2.1-or-later and carries a LICENSE file
 * matching the canonical text byte-for-byte.
 */
export function auditLibraryLicenses(
  libraries: readonly WorkspacePackage[],
  canonicalText: string,
  readLicenseFile: (dir: string) => string | null,
): CheckReport {
  const report = emptyReport();
  for (const library of libraries) {
    if (library.packageJson.license !== LIBRARY_LICENSE) {
      report.violations.push(
        `${library.dir}/package.json: "license" is ` +
          `${JSON.stringify(library.packageJson.license)} — libraries under ` +
          `packages/ and workflows/ must declare "${LIBRARY_LICENSE}".`,
      );
    }
    const licenseText = readLicenseFile(library.dir);
    if (licenseText === null) {
      report.violations.push(
        `${library.dir}: missing a LICENSE file — every library carries the ` +
          `canonical LGPL-2.1 text (see ${CANONICAL_LICENSE_TEXT_PATH}).`,
      );
    } else if (licenseText !== canonicalText) {
      report.violations.push(
        `${library.dir}/LICENSE: does not match the canonical LGPL-2.1 text ` +
          `in ${CANONICAL_LICENSE_TEXT_PATH}.`,
      );
    }
  }
  return report;
}

/** Every application defers to the root GPLv2-with-AI-Exception license. */
export function auditAppLicenses(
  apps: readonly WorkspacePackage[],
): CheckReport {
  const report = emptyReport();
  for (const app of apps) {
    if (app.packageJson.license !== APP_LICENSE) {
      report.violations.push(
        `${app.dir}/package.json: "license" is ` +
          `${JSON.stringify(app.packageJson.license)} — apps must declare ` +
          `"${APP_LICENSE}".`,
      );
    }
  }
  return report;
}

async function main(): Promise<void> {
  const root = rootFromArgs(Bun.argv.slice(2));
  const canonicalTextFile = path.join(root, CANONICAL_LICENSE_TEXT_PATH);
  const canonicalText = existsSync(canonicalTextFile)
    ? readFileSync(canonicalTextFile, "utf8")
    : "";
  const [libraries, apps] = await Promise.all([
    listLibraryPackages(root),
    listAppPackages(root),
  ]);
  const report = emptyReport();
  const libraryReport = auditLibraryLicenses(
    libraries,
    canonicalText,
    (dir) => {
      const licenseFile = path.join(root, dir, "LICENSE");
      return existsSync(licenseFile) ? readFileSync(licenseFile, "utf8") : null;
    },
  );
  report.violations.push(...libraryReport.violations);
  report.violations.push(...auditAppLicenses(apps).violations);
  if (libraries.length === 0 && apps.length === 0) {
    report.notes.push("no workspace packages yet.");
  }
  reportAndExit("check:licenses", report);
}

if (import.meta.main) await main();
