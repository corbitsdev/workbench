import {
  hubToolEntriesFromDefinitions,
  manifestFromHubToolEntries,
  type ToolSideEffect,
} from "@workbench/tool-manifest";
import { AB_COMPARE_TOOL_DEFINITIONS } from "./tools";

const SIDE_EFFECTS: Record<string, ToolSideEffect> = {
  ab_preset_quorum: "read",
  ab_preset_compose: "read",
};

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-ab-compare/compose",
      packageName: "@workbench/tools-ab-compare",
      providerName: null,
      entries: hubToolEntriesFromDefinitions(
        AB_COMPARE_TOOL_DEFINITIONS,
        SIDE_EFFECTS,
      ),
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
