import { defineCredentialedToolPackage } from "@workbench/tool-credentials/factory";
import { SUMBLE_HUB_TOOLS } from "./index";

export const sumble = defineCredentialedToolPackage({
  id: "@workbench/tools-sumble/sumble",
  provider: "sumble",
  entries: SUMBLE_HUB_TOOLS,
});
