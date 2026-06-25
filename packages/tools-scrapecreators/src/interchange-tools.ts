import { defineCredentialedToolPackage } from "@workbench/tool-credentials/factory";
import { SCRAPECREATORS_HUB_TOOLS } from "./index";

export const scrapecreators = defineCredentialedToolPackage({
  id: "@workbench/tools-scrapecreators/scrapecreators",
  provider: "scrapecreators",
  entries: SCRAPECREATORS_HUB_TOOLS,
});
