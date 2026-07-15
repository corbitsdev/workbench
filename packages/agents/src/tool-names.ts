// Re-exported from @workbench/agent-core — moved there so
// @workbench/myra can depend on it without pulling in this package.
export {
  PACKAGE_TOOLS_TABLE,
  PACKAGE_PROVIDERS_TABLE,
  providersForToolPackages,
  producibleLlmToolNames,
  bareToolNamesForPin,
  producibleLlmToolNamesForPins,
  canonicalizeToolNames,
  toLlmToolName,
  expandToolAliasGrants,
  toolPackagesForCapabilities,
} from "@workbench/agent-core/tool-names";
