import { defineCredentialedToolPackage } from "@workbench/tool-credentials/factory";
import { EXA_HUB_TOOLS } from "./index";

export const exa = defineCredentialedToolPackage({
  id: "@workbench/tools-exa/exa",
  provider: "exa",
  entries: EXA_HUB_TOOLS,
});
