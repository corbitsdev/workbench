import {
  hubToolEntriesFromDefinitions,
  manifestFromHubToolEntries,
  type ToolSideEffect,
} from "@workbench/tool-manifest";
import { ARTIFACT_TOOL_DEFINITIONS } from "./definitions";

const SIDE_EFFECTS: Record<string, ToolSideEffect> = {
  artifact_create: "write",
  artifact_read: "read",
  artifact_read_chunk: "read",
  artifact_write: "write",
  artifact_list: "read",
  artifact_find_by_title: "read",
  artifact_link_file: "write",
  artifact_link_presentation: "write",
  artifact_link_gamma_presentation: "write",
  write_artifact: "write",
  memory_load: "read",
  memory_save: "write",
};

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-artifact/artifact",
      packageName: "@workbench/tools-artifact",
      providerName: null,
      entries: hubToolEntriesFromDefinitions(
        ARTIFACT_TOOL_DEFINITIONS,
        SIDE_EFFECTS,
      ),
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
