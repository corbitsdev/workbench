import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/workflow-competitor-analysis/core",
      packageName: "@workbench/workflow-competitor-analysis",
      providerName: null,
      entries: {
        competitor_analysis_format_report_document: {
          sideEffect: "read",
        },
        competitor_analysis_build_review_gate: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
