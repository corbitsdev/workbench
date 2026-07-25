import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/workflow-github-topic-watch/core",
      packageName: "@workbench/workflow-github-topic-watch",
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
