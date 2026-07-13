import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { HACKERNEWS_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-hackernews/hackernews",
      packageName: "@workbench/tools-hackernews",
      providerName: null,
      entries: HACKERNEWS_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "hackernews",
        summary: "Hacker News — search stories and discussions.",
        tags: ["hackernews", "hn", "news", "tech", "community"],
      },
      credentialCatalog: null,
    }),
  ],
};
