import {
  hubToolEntriesFromDefinitions,
  manifestFromHubToolEntries,
} from "@workbench/tool-manifest";
import { SKILL_TOOL_DEFINITIONS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-skills/skills",
      packageName: "@workbench/tools-skills",
      providerName: null,
      entries: hubToolEntriesFromDefinitions(SKILL_TOOL_DEFINITIONS),
      myraCatalog: {
        catalogPackage: "skills",
        summary:
          "Skills library — list every skill, read and improve your pending drafts, and draft new ones.",
        tags: ["skills", "guidance", "playbooks", "how-to", "capabilities"],
      },
      credentialCatalog: null,
    }),
  ],
};
