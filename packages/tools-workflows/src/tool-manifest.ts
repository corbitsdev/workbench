import {
  hubToolEntriesFromDefinitions,
  manifestFromHubToolEntries,
  type ToolSideEffect,
} from "@workbench/tool-manifest";
import { WORKFLOW_TOOL_DEFINITIONS } from "./definitions";

const SIDE_EFFECTS: Record<string, ToolSideEffect> = {
  workflow_list_kinds: "read",
  workflow_start: "write",
  workflow_list_runs: "read",
  workflow_signal: "write",
};

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-workflows/workflows",
      packageName: "@workbench/tools-workflows",
      providerName: null,
      entries: hubToolEntriesFromDefinitions(
        WORKFLOW_TOOL_DEFINITIONS,
        SIDE_EFFECTS,
      ),
      myraCatalog: {
        catalogPackage: "workflows",
        summary: "Workflow run controls — list runs and signal awaiting gates.",
        tags: ["workflow", "runs", "signal", "gate", "control"],
      },
      credentialCatalog: null,
    }),
  ],
};
