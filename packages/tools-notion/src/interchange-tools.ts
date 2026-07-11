import { defineCredentialedToolPackage } from "@workbench/tool-credentials/factory";
import { NOTION_HUB_TOOLS } from "./index";

export const notion = defineCredentialedToolPackage({
  id: "@workbench/tools-notion/notion",
  provider: "notion",
  entries: NOTION_HUB_TOOLS,
});
