import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { REDDIT_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-reddit/reddit",
      packageName: "@workbench/tools-reddit",
      providerName: "scrapecreators",
      entries: REDDIT_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "reddit",
        summary: "Reddit — search posts and subreddits.",
        tags: ["reddit", "social", "community", "discussions"],
      },
      credentialCatalog: {
        label: "ScrapeCreators",
        platforms: ["Reddit", "TikTok", "Instagram", "Threads", "Pinterest"],
      },
    }),
  ],
};
