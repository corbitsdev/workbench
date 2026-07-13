import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MYRA_CATALOG_PACKAGES } from "@workbench/agents/dynamic-tools-catalog";
import {
  PACKAGE_PROVIDERS_TABLE,
  PACKAGE_TOOLS_TABLE,
} from "@workbench/agents/tool-names";
import { CREDENTIAL_PROVIDER_CATALOG } from "@workbench/shared";
import type { HubToolEntries } from "@workbench/tool-manifest";
import { TOOL_PACKAGES } from "./build-tool-packages";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const WRITE_BARE_TOOLS = new Set([
  "ab_preset_compose",
  "artifact_create",
  "artifact_write",
  "write_artifact",
  "artifact_link_file",
  "artifact_link_presentation",
  "artifact_link_gamma_presentation",
  "memory_save",
  "attio_create_note",
  "attio_create_record",
  "attio_update_task",
  "dispatch_agent",
  "firecrawl_crawl_start",
  "firecrawl_batch_scrape_start",
  "firecrawl_extract_start",
  "firecrawl_agent",
  "firecrawl_monitor_create",
  "firecrawl_monitor_update",
  "firecrawl_monitor_delete",
  "firecrawl_monitor_run",
  "firecrawl_interact",
  "firecrawl_browser_session_delete",
  "gamma_create_from_template",
  "gamma_duplicate_presentation",
  "identity_set",
  "linear_create_issue",
  "notion_create_page",
  "skill_draft",
  "slack_post_message",
  "vercel_deploy_static_file",
  "vercel_deploy_artifact",
  "workflow_start",
  "workflow_signal",
]);

function defaultSideEffect(name: string): "read" | "write" {
  if (WRITE_BARE_TOOLS.has(name)) return "write";
  return "read";
}

function packageNameFromFactory(factoryId: string): string {
  const idx = factoryId.lastIndexOf("/");
  if (idx <= 0) return factoryId;
  return factoryId.slice(0, idx);
}

function factoriesForPackage(packageName: string): string[] {
  return Object.keys(PACKAGE_TOOLS_TABLE)
    .filter((factoryId) => packageNameFromFactory(factoryId) === packageName)
    .sort();
}

async function loadHubToolEntries(
  packageDir: string,
): Promise<HubToolEntries | null> {
  const indexPath = join(REPO_ROOT, packageDir, "src/index.ts");
  const mod = (await import(pathToFileURL(indexPath).href)) as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(mod)) {
    if (!key.endsWith("_HUB_TOOLS")) continue;
    if (typeof value !== "object" || value === null) continue;
    const entries: HubToolEntries = {};
    for (const [name, entry] of Object.entries(
      value as Record<string, { sideEffect?: string }>,
    )) {
      if (entry.sideEffect === "read" || entry.sideEffect === "write") {
        entries[name] = { sideEffect: entry.sideEffect };
      }
    }
    return entries;
  }
  return null;
}

function entriesForFactory(
  factoryId: string,
  hubTools: HubToolEntries | null,
): HubToolEntries {
  const names = PACKAGE_TOOLS_TABLE[factoryId] ?? [];
  const entries: HubToolEntries = {};
  for (const name of names) {
    const fromHub = hubTools?.[name];
    if (fromHub !== undefined) {
      entries[name] = fromHub;
      continue;
    }
    entries[name] = { sideEffect: defaultSideEffect(name) };
  }
  return entries;
}

function myraForPackage(packageName: string) {
  return MYRA_CATALOG_PACKAGES.find((p) => p.pin === packageName);
}

function credentialCatalogForProvider(providerName: string | undefined) {
  if (providerName === undefined) return null;
  const row = CREDENTIAL_PROVIDER_CATALOG.find(
    (e) => e.kind === "tool" && e.providerName === providerName,
  );
  if (row === undefined) return null;
  const catalog: Record<string, unknown> = { label: row.label };
  if ("secretLabel" in row && row.secretLabel !== undefined) {
    catalog.secretLabel = row.secretLabel;
  }
  if ("secondaryField" in row && row.secondaryField !== undefined) {
    catalog.secondaryField = row.secondaryField;
  }
  if ("platforms" in row && row.platforms !== undefined) {
    catalog.platforms = row.platforms;
  }
  return catalog;
}

function serializeValue(value: unknown, indent: number): string {
  const pad = " ".repeat(indent);
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((v) => `${pad}  ${serializeValue(v, indent + 2)},`).join("\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return `{\n${entries
      .map(
        ([k, v]) =>
          `${pad}  ${/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) ? k : JSON.stringify(k)}: ${serializeValue(v, indent + 2)},`,
      )
      .join("\n")}\n${pad}}`;
  }
  return String(value);
}

function renderManifestFile(
  packageName: string,
  hubToolsImport: string | null,
  hubTools: HubToolEntries | null,
  factories: {
    factoryId: string;
    entries: HubToolEntries;
    providerName: string | null;
    myraCatalog: ReturnType<typeof myraForPackage>;
    credentialCatalog: ReturnType<typeof credentialCatalogForProvider>;
  }[],
): string {
  const importHub =
    hubToolsImport !== null
      ? `import { ${hubToolsImport} } from "./index";\n`
      : "";
  const factoryBlocks = factories
    .map((f) => {
      const myra = f.myraCatalog === undefined ? null : f.myraCatalog;
      const tableNames = PACKAGE_TOOLS_TABLE[f.factoryId] ?? [];
      const hubKeys = hubTools ? Object.keys(hubTools) : [];
      const useHubImport =
        hubToolsImport !== null &&
        tableNames.length > 0 &&
        tableNames.every((n) => hubTools?.[n] !== undefined) &&
        hubKeys.length === tableNames.length;
      if (useHubImport) {
        return `    manifestFromHubToolEntries({
      factoryId: ${JSON.stringify(f.factoryId)},
      packageName: ${JSON.stringify(packageName)},
      providerName: ${f.providerName === null ? "null" : JSON.stringify(f.providerName)},
      entries: ${hubToolsImport},
      myraCatalog: ${serializeValue(myra, 6)},
      credentialCatalog: ${serializeValue(f.credentialCatalog, 6)},
    })`;
      }
      return `    manifestFromHubToolEntries({
      factoryId: ${JSON.stringify(f.factoryId)},
      packageName: ${JSON.stringify(packageName)},
      providerName: ${f.providerName === null ? "null" : JSON.stringify(f.providerName)},
      entries: ${serializeValue(f.entries, 6)},
      myraCatalog: ${serializeValue(myra, 6)},
      credentialCatalog: ${serializeValue(f.credentialCatalog, 6)},
    })`;
    })
    .join(",\n");

  return `import {
  manifestFromHubToolEntries,
} from "@workbench/tool-manifest";
${importHub}
export const toolManifestFile = {
  factories: [
${factoryBlocks},
  ],
};
`;
}

function patchPackageJson(packageDir: string, packageName: string): void {
  const pkgJsonPath = join(REPO_ROOT, packageDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    interchange?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  pkg.interchange = { ...pkg.interchange, manifest: "./src/tool-manifest.ts" };
  pkg.dependencies = {
    ...pkg.dependencies,
    "@workbench/tool-manifest": "workspace:*",
  };
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  process.stdout.write(`patched ${packageName} package.json\n`);
}

async function main(): Promise<void> {
  for (const spec of TOOL_PACKAGES) {
    patchPackageJson(spec.packageDir, spec.name);
    const packageName = spec.name;
    const hubTools = await loadHubToolEntries(spec.packageDir);
    const hubToolsImport =
      hubTools !== null
        ? (Object.keys(
            await import(
              pathToFileURL(join(REPO_ROOT, spec.packageDir, "src/index.ts"))
                .href
            ),
          ).find((k) => k.endsWith("_HUB_TOOLS")) ?? null)
        : null;

    const factoryIds = factoriesForPackage(packageName);
    const provider = PACKAGE_PROVIDERS_TABLE[packageName];
    const myra = myraForPackage(packageName);

    const factories = factoryIds.map((factoryId) => {
      const entries = entriesForFactory(factoryId, hubTools);
      const ownsMyra =
        myra != null &&
        (factoryIds.length === 1 || factoryId.endsWith(`/${myra.package}`));
      const ownsCredential =
        provider != null &&
        !factoryId.includes("gamma-templates") &&
        !factoryId.includes("deploy-artifact") &&
        (factoryIds.length === 1 || factoryId.endsWith(`/${provider}`));
      return {
        factoryId,
        entries,
        providerName:
          factoryId.includes("gamma-templates") ||
          factoryId.includes("deploy-artifact")
            ? null
            : (provider ?? null),
        myraCatalog: ownsMyra
          ? {
              catalogPackage: myra.package,
              summary: myra.summary,
              tags: [...myra.tags],
            }
          : undefined,
        credentialCatalog: ownsCredential
          ? credentialCatalogForProvider(provider)
          : null,
      };
    });

    const content = renderManifestFile(
      packageName,
      hubToolsImport,
      hubTools,
      factories,
    );
    const outPath = join(REPO_ROOT, spec.packageDir, "src/tool-manifest.ts");
    writeFileSync(outPath, content, "utf8");
    process.stdout.write(`wrote ${outPath}\n`);
  }
}

if (import.meta.main) {
  await main();
}
