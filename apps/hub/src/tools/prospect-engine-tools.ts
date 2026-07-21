// Hub-proxy registry entries for prospect-engine pure tools.

import {
  PROSPECT_ENGINE_CHARGE_CREDITS_DEFINITION,
  PROSPECT_ENGINE_DEDUPE_CANDIDATES_DEFINITION,
  PROSPECT_ENGINE_FORMAT_MAIL_REFS_DEFINITION,
  PROSPECT_ENGINE_FORMAT_REPORT_DEFINITION,
  PROSPECT_ENGINE_FORMAT_SLACK_DIGEST_DEFINITION,
  PROSPECT_ENGINE_INIT_BUDGET_DEFINITION,
  PROSPECT_ENGINE_MERGE_LEDGER_DEFINITION,
  PROSPECT_ENGINE_PARSE_LEDGER_DEFINITION,
  PROSPECT_ENGINE_QUALIFY_DEFINITION,
  PROSPECT_ENGINE_SERIALIZE_LEDGER_DEFINITION,
  createProspectEngineTools,
} from "@workbench/tools-prospect-engine";
import type { ContextToolEntry } from "../lib/tool-registry";

function toolByName(name: string) {
  return () => {
    const tool = createProspectEngineTools().find(
      (t) => t.definition.name === name,
    );
    if (tool === undefined)
      throw new Error(`prospect-engine tool not found: ${name}`);
    return [tool];
  };
}

export const PROSPECT_ENGINE_HUB_TOOLS: Record<string, ContextToolEntry> = {
  prospect_engine_init_budget: {
    sideEffect: "read",
    definition: PROSPECT_ENGINE_INIT_BUDGET_DEFINITION,
    createTools: toolByName("prospect_engine_init_budget"),
  },
  prospect_engine_charge_credits: {
    sideEffect: "read",
    definition: PROSPECT_ENGINE_CHARGE_CREDITS_DEFINITION,
    createTools: toolByName("prospect_engine_charge_credits"),
  },
  prospect_engine_parse_ledger: {
    sideEffect: "read",
    definition: PROSPECT_ENGINE_PARSE_LEDGER_DEFINITION,
    createTools: toolByName("prospect_engine_parse_ledger"),
  },
  prospect_engine_merge_ledger: {
    sideEffect: "read",
    definition: PROSPECT_ENGINE_MERGE_LEDGER_DEFINITION,
    createTools: toolByName("prospect_engine_merge_ledger"),
  },
  prospect_engine_dedupe_candidates: {
    sideEffect: "read",
    definition: PROSPECT_ENGINE_DEDUPE_CANDIDATES_DEFINITION,
    createTools: toolByName("prospect_engine_dedupe_candidates"),
  },
  prospect_engine_qualify: {
    sideEffect: "read",
    definition: PROSPECT_ENGINE_QUALIFY_DEFINITION,
    createTools: toolByName("prospect_engine_qualify"),
  },
  prospect_engine_format_report: {
    sideEffect: "read",
    definition: PROSPECT_ENGINE_FORMAT_REPORT_DEFINITION,
    createTools: toolByName("prospect_engine_format_report"),
  },
  prospect_engine_format_slack_digest: {
    sideEffect: "read",
    definition: PROSPECT_ENGINE_FORMAT_SLACK_DIGEST_DEFINITION,
    createTools: toolByName("prospect_engine_format_slack_digest"),
  },
  prospect_engine_format_mail_refs: {
    sideEffect: "read",
    definition: PROSPECT_ENGINE_FORMAT_MAIL_REFS_DEFINITION,
    createTools: toolByName("prospect_engine_format_mail_refs"),
  },
  prospect_engine_serialize_ledger: {
    sideEffect: "read",
    definition: PROSPECT_ENGINE_SERIALIZE_LEDGER_DEFINITION,
    createTools: toolByName("prospect_engine_serialize_ledger"),
  },
};
