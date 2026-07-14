import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-workflows/workflows",
      packageName: "@workbench/tools-workflows",
      providerName: null,
      entries: {
        workflow_list_kinds: {
          sideEffect: "read",
        },
        workflow_start: {
          sideEffect: "write",
        },
        workflow_list_runs: {
          sideEffect: "read",
        },
        workflow_signal: {
          sideEffect: "write",
        },
      },
      myraCatalog: {
        catalogPackage: "workflows",
        summary: "Workflow run controls — list runs and signal awaiting gates.",
        tags: ["workflow", "runs", "signal", "gate", "control"],
      },
      credentialCatalog: null,
    }),
  ],
};
