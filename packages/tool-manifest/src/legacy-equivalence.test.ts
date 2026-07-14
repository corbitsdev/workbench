import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIAL_PROVIDER_CATALOG } from "@workbench/shared";
import { loadCommittedToolManifestFactories } from "./committed-index";
import {
  deriveMyraCatalogPackages,
  derivePackageProviders,
  derivePackageTools,
  deriveToolCredentialCatalogEntries,
  deriveToolPackageSpecs,
} from "./derive";

function repoRoot(): string {
  return join(import.meta.dir, "..", "..", "..");
}

function loadLegacyBaseline(): {
  packageTools: Record<string, string[]>;
  packageProviders: Record<string, string>;
  myraCatalog: ReturnType<typeof deriveMyraCatalogPackages>;
  toolPackageNames: string[];
} {
  const raw = JSON.parse(
    readFileSync(
      join(
        repoRoot(),
        "apps/hub/generated/tool-manifests/legacy-baseline.json",
      ),
      "utf8",
    ),
  ) as {
    packageTools: Record<string, string[]>;
    packageProviders: Record<string, string>;
    myraCatalog: ReturnType<typeof deriveMyraCatalogPackages>;
    toolPackageNames: string[];
  };
  return raw;
}

function sortedRecord(
  record: Record<string, readonly string[] | string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = [...record[key]].sort();
  }
  return out;
}

describe("tool manifest index vs CL-3447 legacy baseline", () => {
  const factories = loadCommittedToolManifestFactories();
  const legacy = loadLegacyBaseline();

  test("PACKAGE_TOOLS matches legacy baseline", () => {
    expect(sortedRecord(derivePackageTools(factories))).toEqual(
      sortedRecord(legacy.packageTools),
    );
  });

  test("PACKAGE_PROVIDERS matches legacy baseline", () => {
    expect(derivePackageProviders(factories)).toEqual(legacy.packageProviders);
  });

  test("MYRA_CATALOG_PACKAGES matches legacy baseline", () => {
    expect(deriveMyraCatalogPackages(factories)).toEqual(legacy.myraCatalog);
  });

  test("tool credential catalog subset matches derived entries", () => {
    const legacyToolProviders = CREDENTIAL_PROVIDER_CATALOG.filter(
      (e) => e.kind === "tool",
    )
      .filter((e) => !e.providerName.endsWith("-oauth-app"))
      .map((e) => e.providerName)
      .sort();

    const derived = deriveToolCredentialCatalogEntries(factories)
      .map((e) => e.providerName)
      .sort();

    for (const providerName of legacyToolProviders) {
      if (
        providerName === "linear-oauth-app" ||
        providerName === "attio-oauth-app"
      ) {
        continue;
      }
      expect(derived).toContain(providerName);
    }

    const legacyByProvider = new Map(
      CREDENTIAL_PROVIDER_CATALOG.filter((e) => e.kind === "tool").map((e) => [
        e.providerName,
        e,
      ]),
    );
    for (const entry of deriveToolCredentialCatalogEntries(factories)) {
      const legacyEntry = legacyByProvider.get(entry.providerName);
      expect(legacyEntry).toBeDefined();
      expect(entry.label).toBe(legacyEntry!.label);
      if (
        "secretLabel" in legacyEntry! &&
        legacyEntry!.secretLabel !== undefined
      ) {
        expect(entry.secretLabel).toBe(legacyEntry!.secretLabel);
      }
      if ("platforms" in legacyEntry! && legacyEntry!.platforms !== undefined) {
        expect(entry.platforms).toEqual([...legacyEntry!.platforms]);
      }
    }
  });

  test("TOOL_PACKAGES names match legacy baseline package list", () => {
    const derived = deriveToolPackageSpecs(factories)
      .map((s) => s.name)
      .sort();
    expect(derived).toEqual(legacy.toolPackageNames);
  });
});
