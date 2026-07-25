import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-prospect-engine-sumble-bridge/list",
      packageName: "@workbench/tools-prospect-engine-sumble-bridge",
      providerName: "sumble",
      entries: {
        prospect_engine_read_organization_list_tolerant: { sideEffect: "read" },
      },
      credentialCatalog: null,
    }),
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-prospect-engine-sumble-bridge/add",
      packageName: "@workbench/tools-prospect-engine-sumble-bridge",
      providerName: "sumble",
      entries: {
        prospect_engine_add_organization_list_tolerant: { sideEffect: "write" },
      },
      credentialCatalog: null,
    }),
  ],
};
