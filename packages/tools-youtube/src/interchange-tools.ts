import { defineCredentialedToolPackage } from "@workbench/tool-credentials/factory";
import { YOUTUBE_HUB_TOOLS } from "./index";

export const youtube = defineCredentialedToolPackage({
  id: "@workbench/tools-youtube/youtube",
  provider: "youtube",
  entries: YOUTUBE_HUB_TOOLS,
});
