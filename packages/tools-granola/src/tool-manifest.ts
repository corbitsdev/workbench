import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { GRANOLA_HUB_TOOLS, GRANOLA_WORKFLOW_HUB_TOOLS } from "./index";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-granola/granola",
      packageName: "@workbench/tools-granola",
      providerName: "granola",
      entries: GRANOLA_HUB_TOOLS,
      myraCatalog: {
        catalogPackage: "granola",
        summary: "Granola — meeting notes, transcripts, and folders.",
        tags: ["granola", "meetings", "notes", "transcripts", "calls"],
      },
      credentialCatalog: {
        label: "Granola",
      },
    }),
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-granola/workflow",
      packageName: "@workbench/tools-granola",
      providerName: null,
      entries: GRANOLA_WORKFLOW_HUB_TOOLS,
      myraCatalog: null,
      credentialCatalog: null,
    }),
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-granola/call",
      packageName: "@workbench/tools-granola",
      providerName: null,
      entries: {
        granola_create_tasks: { sideEffect: "write" },
        granola_fanout_call: { sideEffect: "write" },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
