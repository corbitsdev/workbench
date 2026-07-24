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
  canonicalizeStepToolName,
  canonicalToolNamesForPackages,
  canonicalizeAgentCapabilityNames,
  LOCAL_RUNNER_TOOL_NAMES,
  toLlmToolName,
  expandToolAliasGrants,
  toolPackagesForCapabilities,
} from "@workbench/agent-core/tool-names";
