import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { LINEAR_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-linear/linear",
      packageName: "@workbench/tools-linear",
      providerName: "linear",
      entries: LINEAR_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "linear",
        summary:
          "Linear — issues, teams, and users for product/engineering work.",
        tags: [
          "linear",
          "issues",
          "tickets",
          "engineering",
          "product",
          "tasks",
        ],
      },
      credentialCatalog: {
        label: "Linear",
      },
    }),
  ],
};
