import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-gtm-scripts-briefs/core",
      packageName: "@workbench/tools-gtm-scripts-briefs",
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
