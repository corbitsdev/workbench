import { defineCredentialedToolPackage } from "@workbench/tool-credentials/factory";
import { SLACK_HUB_TOOLS } from "./index";

export const slack = defineCredentialedToolPackage({
  id: "@workbench/tools-slack/slack",
  provider: "slack",
  entries: SLACK_HUB_TOOLS,
});
