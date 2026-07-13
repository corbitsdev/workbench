import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-ab-compare/compose",
      packageName: "@workbench/tools-ab-compare",
      providerName: null,
      entries: {
        ab_preset_quorum: {
          sideEffect: "read",
        },
        ab_preset_compose: {
          sideEffect: "write",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
