import { defineCredentialedToolPackage } from "@workbench/tool-credentials/factory";
import { VERCEL_HUB_TOOLS } from "./index";

export const vercel = defineCredentialedToolPackage({
  id: "@workbench/tools-vercel/vercel",
  provider: "vercel",
  entries: VERCEL_HUB_TOOLS,
});
