import { defineCredentialedToolPackage } from "@workbench/tool-credentials/factory";
import { X_HUB_TOOLS } from "./index";

export const x = defineCredentialedToolPackage({
  id: "@workbench/tools-x/x",
  provider: "xai",
  entries: X_HUB_TOOLS,
});
