import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { SCRAPECREATORS_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-scrapecreators/scrapecreators",
      packageName: "@workbench/tools-scrapecreators",
      providerName: "scrapecreators",
      entries: SCRAPECREATORS_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "scrapecreators",
        summary:
          "ScrapeCreators — TikTok, Instagram, Threads, and Pinterest search.",
        tags: [
          "social",
          "tiktok",
          "instagram",
          "threads",
          "pinterest",
          "scrapecreators",
        ],
      },
      credentialCatalog: {
        label: "ScrapeCreators",
        platforms: ["Reddit", "TikTok", "Instagram", "Threads", "Pinterest"],
      },
    }),
  ],
};
