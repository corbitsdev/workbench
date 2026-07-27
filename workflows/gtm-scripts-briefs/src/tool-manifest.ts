import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/workflow-gtm-scripts-briefs/core",
      packageName: "@workbench/workflow-gtm-scripts-briefs",
      providerName: null,
      entries: {
        gtm_scripts_briefs_prepare_persist: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
