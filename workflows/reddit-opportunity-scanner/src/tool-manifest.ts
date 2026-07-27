import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { REDDIT_OPPORTUNITY_SCANNER_COLLECT_SEARCHES_DEFINITION } from "./collect-tool";
import { REDDIT_OPPORTUNITY_SCANNER_PERSIST_ITEMS_DEFINITION } from "./persist-tool";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/workflow-reddit-opportunity-scanner/collect",
      packageName: "@workbench/workflow-reddit-opportunity-scanner",
      providerName: null,
      entries: {
        [REDDIT_OPPORTUNITY_SCANNER_COLLECT_SEARCHES_DEFINITION.name]: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
    manifestFromHubToolEntries({
      factoryId: "@workbench/workflow-reddit-opportunity-scanner/persist",
      packageName: "@workbench/workflow-reddit-opportunity-scanner",
      providerName: null,
      entries: {
        [REDDIT_OPPORTUNITY_SCANNER_PERSIST_ITEMS_DEFINITION.name]: {
          sideEffect: "write",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
