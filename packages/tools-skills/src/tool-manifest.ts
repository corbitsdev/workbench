import {
  hubToolEntriesFromDefinitions,
  manifestFromHubToolEntries,
  type ToolSideEffect,
} from "@workbench/tool-manifest";
import { SKILL_TOOL_DEFINITIONS } from "./index";

const SIDE_EFFECTS: Record<string, ToolSideEffect> = {
  list_skills: "read",
  search_skills: "read",
  load_skill: "read",
  list_skill_drafts: "read",
  load_skill_draft: "read",
  skill_draft: "write",
};

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-skills/skills",
      packageName: "@workbench/tools-skills",
      providerName: null,
      entries: hubToolEntriesFromDefinitions(
        SKILL_TOOL_DEFINITIONS,
        SIDE_EFFECTS,
      ),
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
