import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { GRANOLA_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-granola/granola",
      packageName: "@workbench/tools-granola",
      providerName: "granola",
      entries: GRANOLA_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "granola",
        summary: "Granola — meeting notes, transcripts, and folders.",
        tags: ["granola", "meetings", "notes", "transcripts", "calls"],
      },
      credentialCatalog: {
        label: "Granola",
      },
    }),
  ],
};
