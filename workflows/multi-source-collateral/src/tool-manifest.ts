import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { MULTI_SOURCE_COLLATERAL_LIST_ISSUES_DEFINITION } from "./list-issues-tool";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-multi-source-collateral/list-issues",
      packageName: "@workbench/tools-multi-source-collateral",
      providerName: null,
      entries: {
        [MULTI_SOURCE_COLLATERAL_LIST_ISSUES_DEFINITION.name]: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
