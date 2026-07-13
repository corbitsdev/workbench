import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { FIRECRAWL_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-firecrawl/firecrawl",
      packageName: "@workbench/tools-firecrawl",
      providerName: "firecrawl",
      entries: FIRECRAWL_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "firecrawl",
        summary:
          "Firecrawl — scrape, search, map, crawl, extract, and monitor the web.",
        tags: [
          "firecrawl",
          "web",
          "scrape",
          "crawl",
          "search",
          "research",
          "extract",
        ],
      },
      credentialCatalog: {
        label: "Firecrawl",
      },
    }),
  ],
};
