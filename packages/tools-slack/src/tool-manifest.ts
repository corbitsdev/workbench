import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { SLACK_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-slack/slack",
      packageName: "@workbench/tools-slack",
      providerName: "slack",
      entries: SLACK_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "slack",
        summary:
          "Slack — list channels, read channel/thread history, keyword-search bot-visible channels, and post messages.",
        tags: ["slack", "channels", "messages", "chat", "search", "post"],
      },
      credentialCatalog: {
        label: "Slack",
        secretLabel: "Bot token",
        platforms: ["Slack"],
      },
    }),
  ],
};
