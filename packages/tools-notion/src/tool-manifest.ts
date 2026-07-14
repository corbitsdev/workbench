import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { NOTION_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-notion/notion",
      packageName: "@workbench/tools-notion",
      providerName: "notion",
      entries: NOTION_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "notion",
        summary:
          "Notion — search, read, and create workspace pages and databases.",
        tags: [
          "notion",
          "pages",
          "databases",
          "docs",
          "notes",
          "wiki",
          "knowledge",
        ],
      },
      credentialCatalog: null,
    }),
  ],
};
