import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-github-topic-watch/core",
      packageName: "@workbench/tools-github-topic-watch",
      providerName: null,
      entries: {
        github_topic_watch_format_activity_query: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
