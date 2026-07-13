import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { YOUTUBE_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-youtube/youtube",
      packageName: "@workbench/tools-youtube",
      providerName: "youtube",
      entries: YOUTUBE_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "youtube",
        summary: "YouTube — search videos and channels.",
        tags: ["youtube", "video", "social", "content"],
      },
      credentialCatalog: {
        label: "YouTube",
      },
    }),
  ],
};
