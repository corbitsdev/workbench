import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-prospect-engine-slack-bridge/post",
      packageName: "@workbench/tools-prospect-engine-slack-bridge",
      providerName: "slack",
      entries: {
        prospect_engine_post_slack_tolerant: { sideEffect: "write" },
      },
      credentialCatalog: null,
    }),
  ],
};
