import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-gamma-presentation-creator/core",
      packageName: "@workbench/tools-gamma-presentation-creator",
      providerName: null,
      entries: {
        gamma_presentation_creator_prepare_render: {
          sideEffect: "read",
        },
        gamma_presentation_creator_prepare_persist: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-gamma-presentation-creator/fetch",
      packageName: "@workbench/tools-gamma-presentation-creator",
      providerName: null,
      entries: {
        gamma_presentation_creator_fetch_artifact: {
          sideEffect: "read",
        },
        gamma_presentation_creator_fetch_note: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
