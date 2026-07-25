import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-reddit-opportunity-watch/core",
      packageName: "@workbench/tools-reddit-opportunity-watch",
      providerName: null,
      entries: {
        reddit_opportunity_watch_format_digest_document: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
