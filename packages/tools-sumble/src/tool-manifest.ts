import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { SUMBLE_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-sumble/sumble",
      packageName: "@workbench/tools-sumble",
      providerName: "sumble",
      entries: SUMBLE_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "sumble",
        summary:
          "Sumble account intelligence — look up organizations, teams, people, jobs, and buying signals; build intelligence briefs and manage saved lists.",
        tags: [
          "sumble",
          "account",
          "intelligence",
          "prospecting",
          "tech stack",
          "signals",
          "people",
          "enrichment",
        ],
      },
      credentialCatalog: {
        label: "Sumble",
      },
    }),
  ],
};
