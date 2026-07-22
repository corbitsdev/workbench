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
          "Artifact tools beyond the basics: read large artifacts in chunks, look up an artifact by title, and link a file or presentation to one.",
        tags: ["artifact", "deliverable", "chunk", "link", "presentation"],
      },
      credentialCatalog: null,
    }),
  ],
};
