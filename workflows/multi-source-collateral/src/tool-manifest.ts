import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { MULTI_SOURCE_COLLATERAL_LIST_ISSUES_DEFINITION } from "./list-issues-tool";
import {
  MULTI_SOURCE_COLLATERAL_FETCH_ARTIFACTS_DEFINITION,
  MULTI_SOURCE_COLLATERAL_FETCH_NOTES_DEFINITION,
  MULTI_SOURCE_COLLATERAL_FETCH_ISSUES_DEFINITION,
} from "./fetch-tools";
import { MULTI_SOURCE_COLLATERAL_PERSIST_PIECES_DEFINITION } from "./persist-tools";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/workflow-multi-source-collateral/list-issues",
      packageName: "@workbench/workflow-multi-source-collateral",
      providerName: null,
      entries: {
        [MULTI_SOURCE_COLLATERAL_LIST_ISSUES_DEFINITION.name]: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
    manifestFromHubToolEntries({
      factoryId: "@workbench/workflow-multi-source-collateral/fetch",
      packageName: "@workbench/workflow-multi-source-collateral",
      providerName: null,
      entries: {
        [MULTI_SOURCE_COLLATERAL_FETCH_ARTIFACTS_DEFINITION.name]: {
          sideEffect: "read",
        },
        [MULTI_SOURCE_COLLATERAL_FETCH_NOTES_DEFINITION.name]: {
          sideEffect: "read",
        },
        [MULTI_SOURCE_COLLATERAL_FETCH_ISSUES_DEFINITION.name]: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
    manifestFromHubToolEntries({
      factoryId: "@workbench/workflow-multi-source-collateral/persist",
      packageName: "@workbench/workflow-multi-source-collateral",
      providerName: null,
      entries: {
        [MULTI_SOURCE_COLLATERAL_PERSIST_PIECES_DEFINITION.name]: {
          sideEffect: "write",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
