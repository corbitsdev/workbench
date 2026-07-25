import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-sumble-account-intel/core",
      packageName: "@workbench/tools-sumble-account-intel",
      providerName: null,
      entries: {
        sumble_account_intel_format_report_document: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
