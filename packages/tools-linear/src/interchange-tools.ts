import { defineCredentialedToolPackage } from "@workbench/tool-credentials/factory";
import { LINEAR_HUB_TOOLS } from "./index";

export const linear = defineCredentialedToolPackage({
  id: "@workbench/tools-linear/linear",
  provider: "linear",
  entries: LINEAR_HUB_TOOLS,
});
