import type { ToolPackagePin } from "@intx/types/tool-packages";
import {
  derivePackageProviders,
  derivePackageTools,
  loadCommittedToolManifestFactories,
} from "@workbench/tool-manifest";

const toolManifestFactories = loadCommittedToolManifestFactories();

// Canonical (namespace-prefixed) tool names for native tool packages.
//
// The sidecar tool-packaging loader prefixes every tool definition name with
// its package factory id (`<factoryId>:<name>`), and the authz layer grants and
// checks `tool:<runtime name>` at invoke time. Agent capability lists must
// therefore carry the prefixed name so the grants the hub seeds from them match
// what the runtime asks for (CL-2145). Local sidecar runners — posix
// (`read_file`, `write_file`, `edit_file`, `search_files`, `run_shell`, `grep`),
// mail (`mail_*`) — are merged directly (not loaded as packages) and are NOT
// prefixed; they pass through unchanged.
//
// Bare tool names per factory id, derived from committed manifests — update
// manifests and run `bun run build:tool-manifests` instead of editing here.
// Names not present here (locals, or not-yet-real tools) are returned verbatim.

/** Derived from committed per-package tool manifests (`apps/hub/generated/tool-manifests/index.json`). */
export const PACKAGE_TOOLS_TABLE: Record<string, readonly string[]> =
  derivePackageTools(toolManifestFactories);

const FACTORY_ID_BY_TOOL: Record<string, string> = Object.fromEntries(
  Object.entries(PACKAGE_TOOLS_TABLE).flatMap(([factoryId, names]) =>
    names.map((name) => [name, factoryId]),
  ),
);

// The credential provider each tool package's factory declares
// (`defineCredentialedToolPackage({ provider })`). Keyed by pin name (the
// `@scope/package` an agent pins, i.e. the factory id without its tool
// segment). Packages absent here are keyless or hub-backed (agents, artifact,
// dispatch, hackernews, polymarket, last30days) and need no tenant credential.
export const PACKAGE_PROVIDERS_TABLE: Record<string, string> =
  derivePackageProviders(toolManifestFactories);

// The distinct credential providers a set of pinned tool packages requires.
// The hub credential gate authorizes a deployed agent (or workflow step) for
// exactly these providers — derived from its persisted pins, not a tool-name
// registry. Keyless/hub-backed packages contribute nothing.
export function providersForToolPackages(
  pins: readonly ToolPackagePin[],
): string[] {
  const providers = new Set<string>();
  for (const pin of pins) {
    const provider = PACKAGE_PROVIDERS_TABLE[pin.name];
    if (provider !== undefined) providers.add(provider);
  }
  return [...providers];
}

/**
 * Every LLM-facing tool name a known tool package can produce, via the same
 * `<factoryId>:<name>` → `toLlmToolName` transform the sidecar applies to a
 * loaded package's tool definitions. The dynamic-tools catalog must name only
 * tools in this set: the credential-gate filter matches a catalog entry against
 * the loaded tool names, so a catalog name no factory can produce would be
 * silently hidden forever. Pin the catalog against this set in a test.
 */
export function producibleLlmToolNames(): Set<string> {
  const names = new Set<string>();
  for (const [factoryId, tools] of Object.entries(PACKAGE_TOOLS_TABLE)) {
    for (const tool of tools) names.add(toLlmToolName(`${factoryId}:${tool}`));
  }
  return names;
}

/**
 * The bare (unprefixed) tool names a single pinned package ships, across all its
 * factories. A tarball can ship several factories (`@workbench/tools-vercel/
 * vercel` and `@workbench/tools-vercel/deploy-artifact`), so a pin name matches
 * every `PACKAGE_TOOLS_TABLE` factory it prefixes. This is the one source the Myra
 * catalog + grants derive from, so a package's tools are never hand-listed
 * twice (CL-3190).
 */
export function bareToolNamesForPin(pinName: string): string[] {
  const names: string[] = [];
  for (const [factoryId, tools] of Object.entries(PACKAGE_TOOLS_TABLE)) {
    if (factoryId === pinName || factoryId.startsWith(`${pinName}/`)) {
      names.push(...tools);
    }
  }
  return names;
}

/**
 * The LLM-facing tool names materialized by a set of pinned packages — what the
 * sidecar actually loads for an agent. The dynamic-tools partition (platform ∪
 * catalog) must exactly cover this so nothing leaks onto turn-1 advertisement
 * (CL-3190).
 */
export function producibleLlmToolNamesForPins(
  pins: readonly ToolPackagePin[],
): Set<string> {
  const names = new Set<string>();
  for (const pin of pins) {
    for (const bare of bareToolNamesForPin(pin.name)) {
      names.add(toLlmToolName(canonicalizeToolNames([bare])[0] ?? bare));
    }
  }
  return names;
}

/**
 * Map raw tool-definition names to the canonical runtime names the sidecar
 * loader emits (`<factoryId>:<name>`). Names belonging to a known tool package
 * are prefixed; everything else (local runners) is returned unchanged.
 */
export function canonicalizeToolNames(names: readonly string[]): string[] {
  return names.map((name) => {
    const factoryId = FACTORY_ID_BY_TOOL[name];
    return factoryId === undefined ? name : `${factoryId}:${name}`;
  });
}

/**
 * Map a canonical runtime tool name (`<factoryId>:<tool>`) to an LLM-safe
 * function name. Provider function names must match `[a-zA-Z0-9_-]` (≤64); the
 * canonical name's `@`, `/`, and especially `:` do not round-trip (kimi-k2.6
 * returns only the part before the `:`, so the call never matches its grant or
 * the loader's dispatch entry — CL-2306). Emits `<pkgShort>__<tool>`, dropping a
 * redundant `<pkgShort>_` prefix on the tool name
 * (`@workbench/tools-exa/exa:exa_search` → `exa__search`). Bare local names (no
 * `:`, e.g. `read_file`) are already safe and pass through unchanged.
 *
 * The hub keys tool grants on this name and the sidecar presents it to the
 * model; the canonical `:` name survives only inside the sidecar's dispatch map
 * and pin derivation, neither of which crosses the model boundary.
 */
export function toLlmToolName(name: string): string {
  const colon = name.lastIndexOf(":");
  if (colon === -1) return name;
  const factoryId = name.slice(0, colon);
  const tool = name.slice(colon + 1);
  const pkgShort = factoryId.slice(factoryId.lastIndexOf("/") + 1);
  const short = tool.startsWith(`${pkgShort}_`)
    ? tool.slice(pkgShort.length + 1)
    : tool;
  return `${pkgShort}__${short}`;
}

function factoryIdFromCanonicalOrBare(name: string): string | undefined {
  const colon = name.lastIndexOf(":");
  if (colon === -1) return FACTORY_ID_BY_TOOL[name];
  return name.slice(0, colon);
}

const EXA_FACTORY_ID = "@workbench/tools-exa/exa";

/**
 * Exa registers `exa_search` and `web_search` as the same capability; the model
 * often calls the generic `web_search` name while capabilities list only
 * `exa_search`. Grant both runtime names when either is authorized.
 */
export function expandToolAliasGrants(
  canonicalNames: readonly string[],
): string[] {
  const out = new Set(canonicalNames);
  const hasExa = canonicalNames.some(
    (n) => factoryIdFromCanonicalOrBare(n) === EXA_FACTORY_ID,
  );
  if (!hasExa) return [...out];
  for (const bare of PACKAGE_TOOLS_TABLE[EXA_FACTORY_ID] ?? []) {
    out.add(`${EXA_FACTORY_ID}:${bare}`);
  }
  return [...out];
}

// Resolve the npm tool packages that back a set of capability names (bare or
// canonical `<factoryId>:<name>`). A capability with no known package (a local
// runner) contributes nothing. Used to derive a deploy's toolPackagePins from
// the tools its workflow steps declare, so the sidecar loader materializes them.
export function toolPackagesForCapabilities(
  capabilities: readonly string[],
): ToolPackagePin[] {
  const packages = new Set<string>();
  for (const cap of capabilities) {
    const factoryId = cap.includes(":")
      ? cap.slice(0, cap.lastIndexOf(":"))
      : FACTORY_ID_BY_TOOL[cap];
    if (factoryId === undefined) continue;
    packages.add(factoryId.split("/").slice(0, 2).join("/"));
  }
  return [...packages].sort().map((name) => ({ name, version: "^0.1.0" }));
}
