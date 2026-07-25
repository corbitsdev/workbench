import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-sumble-account-intel/core",
      packageName: "@workbench/tools-sumble-account-intel",
      providerName: null,
      entries: {
        sumble_account_intel_format_report_document: {
          sideEffect: "read",
        },
        sumble_account_intel_resolve_organization: {
          sideEffect: "read",
        },
        sumble_account_intel_search_people: {
          sideEffect: "read",
        },
        sumble_account_intel_list_teams: {
          sideEffect: "read",
        },
        sumble_account_intel_list_jobs: {
          sideEffect: "read",
        },
        sumble_account_intel_search_signals: {
          sideEffect: "read",
        },
        sumble_account_intel_enrich_contacts: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
