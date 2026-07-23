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
 *
 * Lenient by design: several legitimate callers (the hub's tool-registry
 * grant gate, capability walks) pass names that are not workflow-step tool
 * declarations and must never throw here. Build-time enforcement for a
 * workflow step's declared tool lives in `canonicalizeStepToolName` below —
 * do not add a throw to this function.
 */
export function canonicalizeToolNames(names: readonly string[]): string[] {
  return names.map((name) => {
    const factoryId = FACTORY_ID_BY_TOOL[name];
    return factoryId === undefined ? name : `${factoryId}:${name}`;
  });
}

/**
 * The explicit, enumerated set of bare tool names the sidecar's local (non-
 * package) runners still serve. `apps/sidecar/src/step-tool-harness.ts`
 * merges ALL of `createMailTools(...)`'s tool definitions into the loaded
 * runner (unfiltered) whenever a transport is present, and interchange's
 * `@intx/tools-mail` (`interchange/packages/tools-mail/src/definitions.ts`)
 * registers exactly five: `mail_send`, `mail_reply`, `mail_search`,
 * `mail_read`, `mail_wait`. All five carry no factory id and must stay
 * unprefixed. `packages/agent-core` does not depend on `@intx/tools-mail` (it
 * has no other interchange dependency and stays framework-thin), so this list
 * is a hand-maintained mirror, NOT a derived import — it must be updated by
 * hand if `@intx/tools-mail`'s `TOOL_DEFINITIONS` ever changes. A divergence
 * test (`apps/hub/src/lib/local-runner-tool-names.test.ts`, which already
 * depends on both packages) asserts this set matches
 * `TOOL_DEFINITIONS.map(d => d.name)` exactly, so drift here fails a build
 * gate rather than silently reintroducing this bug.
 *
 * The former POSIX runners (`read_file`, `write_file`, `edit_file`,
 * `search_files`, `run_shell`, `grep`) are gone from the sidecar — they are
 * intentionally NOT in this set. A step naming one of them now fails the
 * build via `canonicalizeStepToolName` rather than silently deploying a call
 * nothing will serve.
 */
export const LOCAL_RUNNER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "mail_send",
  "mail_reply",
  "mail_search",
  "mail_read",
  "mail_wait",
]);

/**
 * Strict, build-time-only canonicalization for a single workflow step's
 * declared tool name. Unlike `canonicalizeToolNames`, this throws when `name`
 * resolves to neither a known tool-package tool nor the explicit local-runner
 * set — turning a typo'd, retired, or manifest-drifted tool name into a hard
 * build failure instead of a step that deploys clean and only fails at
 * dispatch time. `stepId` is folded into the message so the failing step is
 * unambiguous in build output.
 */
export function canonicalizeStepToolName(stepId: string, name: string): string {
  const factoryId = FACTORY_ID_BY_TOOL[name];
  if (factoryId !== undefined) return `${factoryId}:${name}`;
  if (LOCAL_RUNNER_TOOL_NAMES.has(name)) return name;
  throw new Error(
    `deterministicToolStep "${stepId}": tool "${name}" is not a known tool-package ` +
      `name or a local-runner name. Regenerate tool manifests (bun run build:tool-manifests) ` +
      `if this is a real, newly-added tool, or fix the tool name if it is a typo.`,
  );
}

/**
 * Strict, build-time-only canonicalization for an agent definition's declared
 * `capabilities`/tool list — the counterpart of `canonicalizeStepToolName` for
 * workflow steps. `canonicalizeToolNames` (above) stays lenient because
 * several legitimate runtime callers (the hub's grant gate, capability walks)
 * pass names that must never throw; an agent *definition* is a bounded,
 * hand-authored list evaluated at module load, so a typo'd, retired, or
 * never-real tool name here can and should fail the build instead of
 * deploying an agent that only discovers the gap when the model calls it
 * mid-conversation.
 *
 * `nativeToolNames` is the escape hatch for hub-native tools that carry no
 * `@workbench/tools-*` package (e.g. Myra's catalog-runner locals `search_tools`
 * / `load_tools`, or hub-backed writes like `task_create`) — pass the caller's
 * own hand-maintained set of those names. Do not widen `LOCAL_RUNNER_TOOL_NAMES`
 * for this; that set is reserved for the interchange mail-tools mirror and has
 * its own drift test.
 */
export function canonicalizeAgentCapabilityNames(
  agentLabel: string,
  names: readonly string[],
  nativeToolNames: ReadonlySet<string> = new Set(),
): string[] {
  return names.map((name) => {
    const factoryId = FACTORY_ID_BY_TOOL[name];
    if (factoryId !== undefined) return `${factoryId}:${name}`;
    if (LOCAL_RUNNER_TOOL_NAMES.has(name)) return name;
    if (nativeToolNames.has(name)) return name;
    throw new Error(
      `Agent "${agentLabel}" declares capability "${name}", which is not a known ` +
        `tool-package name, local-runner name, or declared native tool name. ` +
        `Regenerate tool manifests (bun run build:tool-manifests) if this is a real, ` +
        `newly-added tool, or fix the capability name if it is a typo/retired tool.`,
    );
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
