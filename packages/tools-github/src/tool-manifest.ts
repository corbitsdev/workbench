import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { GITHUB_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-github/github",
      packageName: "@workbench/tools-github",
      providerName: "github",
      entries: GITHUB_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "github",
        summary: "GitHub — public repository activity and release signals.",
        tags: ["github", "code", "repos", "releases", "engineering"],
      },
      credentialCatalog: {
        label: "GitHub",
      },
    }),
  ],
};
