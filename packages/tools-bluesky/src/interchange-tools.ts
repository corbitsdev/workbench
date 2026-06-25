import { defineCredentialedToolPackage } from "@workbench/tool-credentials/factory";
import { BLUESKY_HUB_TOOLS } from "./index";

export const bluesky = defineCredentialedToolPackage({
  id: "@workbench/tools-bluesky/bluesky",
  provider: "bluesky",
  entries: BLUESKY_HUB_TOOLS,
});
