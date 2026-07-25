import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/workflow-exa-topic-watch/core",
      packageName: "@workbench/workflow-exa-topic-watch",
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
