import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { AGENTS_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-agents/agents",
      packageName: "@workbench/tools-agents",
      providerName: null,
      entries: {
        list_agents: {
          sideEffect: "read",
        },
        search_agents: {
          sideEffect: "read",
        },
        list_principals: {
          sideEffect: "read",
        },
        identity_get: {
          sideEffect: "read",
        },
        identity_set: {
          sideEffect: "write",
        },
        invoke_agent: {
          sideEffect: "write",
        },
      },
      myraCatalog: {
        catalogPackage: "identity",
        summary:
          "Directory and identity — agents, principals, per-tool identity.",
        tags: [
          "identity",
          "directory",
          "agents",
          "principals",
          "accounts",
          "who",
        ],
      },
      credentialCatalog: null,
    }),
  ],
};
