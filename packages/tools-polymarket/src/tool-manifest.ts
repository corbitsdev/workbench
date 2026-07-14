import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { POLYMARKET_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-polymarket/polymarket",
      packageName: "@workbench/tools-polymarket",
      providerName: null,
      entries: POLYMARKET_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "polymarket",
        summary: "Polymarket — prediction market odds.",
        tags: ["polymarket", "markets", "odds", "predictions"],
      },
      credentialCatalog: null,
    }),
  ],
};
