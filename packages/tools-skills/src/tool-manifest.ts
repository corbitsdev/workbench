import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-skills/skills",
      packageName: "@workbench/tools-skills",
      providerName: null,
      entries: {
        list_skills: {
          sideEffect: "read",
        },
        search_skills: {
          sideEffect: "read",
        },
        load_skill: {
          sideEffect: "read",
        },
        list_skill_drafts: {
          sideEffect: "read",
        },
        load_skill_draft: {
          sideEffect: "read",
        },
        skill_draft: {
          sideEffect: "write",
        },
      },
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
