import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-exa-topic-watch/core",
      packageName: "@workbench/tools-exa-topic-watch",
      providerName: null,
      entries: {
        exa_topic_watch_prepare_search: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
