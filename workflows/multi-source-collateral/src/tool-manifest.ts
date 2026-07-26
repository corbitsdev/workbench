import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/workflow-multi-source-collateral/core",
      packageName: "@workbench/workflow-multi-source-collateral",
      providerName: null,
      entries: {
        multi_source_collateral_list_issues: { sideEffect: "read" },
        multi_source_collateral_prepare_sources_gate: { sideEffect: "read" },
        multi_source_collateral_fetch_sources: { sideEffect: "read" },
        multi_source_collateral_prepare_options_gate: { sideEffect: "read" },
        multi_source_collateral_build_generate_items: { sideEffect: "read" },
        multi_source_collateral_prepare_review_gate: { sideEffect: "read" },
        multi_source_collateral_prepare_review_final_gate: {
          sideEffect: "read",
        },
        multi_source_collateral_prepare_regenerate_items: {
          sideEffect: "read",
        },
        multi_source_collateral_persist_pieces: { sideEffect: "write" },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
