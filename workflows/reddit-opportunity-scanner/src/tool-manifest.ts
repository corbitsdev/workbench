import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { REDDIT_OPPORTUNITY_SCANNER_COLLECT_SEARCH_DEFINITION } from "./collect-tool";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/workflow-reddit-opportunity-scanner/collect",
      packageName: "@workbench/workflow-reddit-opportunity-scanner",
      providerName: null,
      entries: {
        [REDDIT_OPPORTUNITY_SCANNER_COLLECT_SEARCH_DEFINITION.name]: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
