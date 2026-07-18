import {
  hubToolEntriesFromDefinitions,
  manifestFromHubToolEntries,
} from "@workbench/tool-manifest";
import { WORKFLOW_TOOL_DEFINITIONS } from "./definitions";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-workflows/workflows",
      packageName: "@workbench/tools-workflows",
      providerName: null,
      entries: hubToolEntriesFromDefinitions(WORKFLOW_TOOL_DEFINITIONS),
      myraCatalog: {
        catalogPackage: "workflows",
        summary: "Workflow run controls — list runs and signal awaiting gates.",
        tags: ["workflow", "runs", "signal", "gate", "control"],
      },
      credentialCatalog: null,
    }),
  ],
};
