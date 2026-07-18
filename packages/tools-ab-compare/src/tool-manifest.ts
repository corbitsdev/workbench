import {
  hubToolEntriesFromDefinitions,
  manifestFromHubToolEntries,
} from "@workbench/tool-manifest";
import { AB_COMPARE_TOOL_DEFINITIONS } from "./tools";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-ab-compare/compose",
      packageName: "@workbench/tools-ab-compare",
      providerName: null,
      entries: hubToolEntriesFromDefinitions(AB_COMPARE_TOOL_DEFINITIONS),
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
