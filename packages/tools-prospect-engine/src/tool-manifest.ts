import { manifestFromHubToolEntries } from "@workbench/tool-manifest";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/tools-prospect-engine/core",
      packageName: "@workbench/tools-prospect-engine",
      providerName: null,
      entries: {
        prospect_engine_init_budget: { sideEffect: "read" },
        prospect_engine_charge_credits: { sideEffect: "read" },
        prospect_engine_parse_ledger: { sideEffect: "read" },
        prospect_engine_merge_ledger: { sideEffect: "read" },
        prospect_engine_dedupe_candidates: { sideEffect: "read" },
        prospect_engine_qualify: { sideEffect: "read" },
        prospect_engine_format_report: { sideEffect: "read" },
        prospect_engine_format_slack_digest: { sideEffect: "read" },
        prospect_engine_format_mail_refs: { sideEffect: "read" },
        prospect_engine_serialize_ledger: { sideEffect: "read" },
        prospect_engine_extract_list_org_ids: { sideEffect: "read" },
        prospect_engine_extract_candidates_from_reply: { sideEffect: "read" },
        prospect_engine_extract_map_reveal_overlay: { sideEffect: "read" },
      },
    }),
  ],
};
