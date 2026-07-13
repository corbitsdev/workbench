import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { EXA_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-exa/exa",
      packageName: "@workbench/tools-exa",
      providerName: "exa",
      entries: EXA_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "exa",
        summary: "Exa — semantic web search and general web search.",
        tags: ["exa", "web", "search", "research"],
      },
      credentialCatalog: {
        label: "Exa",
      },
    }),
  ],
};
