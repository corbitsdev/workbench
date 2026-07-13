import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { BLUESKY_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-bluesky/bluesky",
      packageName: "@workbench/tools-bluesky",
      providerName: "bluesky",
      entries: BLUESKY_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "bluesky",
        summary: "Bluesky — search public posts.",
        tags: ["bluesky", "social", "posts"],
      },
      credentialCatalog: {
        label: "Bluesky",
        secretLabel: "App password",
        secondaryField: {
          label: "Handle",
          placeholder: "you.bsky.social",
          required: true,
        },
      },
    }),
  ],
};
