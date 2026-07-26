import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { PAIN_POINT_COLLATERAL_PERSIST_PIECES_DEFINITION } from "./persist-tool";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/workflow-pain-point-collateral/persist",
      packageName: "@workbench/workflow-pain-point-collateral",
      providerName: null,
      entries: {
        [PAIN_POINT_COLLATERAL_PERSIST_PIECES_DEFINITION.name]: {
          sideEffect: "write",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
