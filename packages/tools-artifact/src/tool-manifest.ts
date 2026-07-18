import {
  hubToolEntriesFromDefinitions,
  manifestFromHubToolEntries,
} from "@workbench/tool-manifest";
import { ARTIFACT_TOOL_DEFINITIONS } from "./definitions";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-artifact/artifact",
      packageName: "@workbench/tools-artifact",
      providerName: null,
      entries: hubToolEntriesFromDefinitions(ARTIFACT_TOOL_DEFINITIONS),
      myraCatalog: {
        catalogPackage: "artifacts",
        summary:
          "Advanced artifact tools — chunked reads, lookup by title, linking.",
        tags: ["artifact", "deliverable", "chunk", "link", "presentation"],
      },
      credentialCatalog: null,
    }),
  ],
};
