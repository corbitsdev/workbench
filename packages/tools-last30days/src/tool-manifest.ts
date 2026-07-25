import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-last30days/core",
      packageName: "@workbench/tools-last30days",
      providerName: null,
      entries: {
        last30days_core_extract: {
          sideEffect: "read",
        },
        last30days_core_report: {
          sideEffect: "read",
        },
        last30days_format_report_document: {
          sideEffect: "read",
        },
        last30days_ground_queries: {
          sideEffect: "read",
        },
        last30days_entity_queries: {
          sideEffect: "read",
        },
        last30days_collect: {
          sideEffect: "read",
        },
        last30days_validate: {
          sideEffect: "read",
        },
        last30days_workflow_brief: {
          sideEffect: "read",
        },
        heartbeat_merge_brief_sources: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
