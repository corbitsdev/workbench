import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { X_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-x/x",
      packageName: "@workbench/tools-x",
      providerName: "xai",
      entries: X_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "x",
        summary: "X (Twitter) — search posts and accounts.",
        tags: ["x", "twitter", "social", "posts"],
      },
      credentialCatalog: null,
    }),
  ],
};
