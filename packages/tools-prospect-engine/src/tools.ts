import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";
import {
  PROSPECT_ENGINE_CREDIT_CAP,
  ProspectEngineCandidateSchema,
  ProspectEngineCreditBudgetSchema,
  type ProspectEngineCandidate,
  type ProspectEngineCreditBudget,
  type ProspectEngineLedger,
  buildProspectEngineReportCsv,
  buildProspectEngineReportMarkdown,
  chargeProspectEngineCredits,
  dedupeProspectCandidates,
  emptyProspectEngineLedger,
  extractOrganizationIds,
  formatProspectEngineSlackDigest,
  initProspectEngineCreditBudget,
  mergeProspectEngineLedger,
  parseProspectEngineLedger,
  prospectEngineMailRefs,
  qualifyProspects,
} from "@workbench/shared";

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const PROSPECT_ENGINE_INIT_BUDGET_DEFINITION: ToolDefinition = {
  name: "prospect_engine_init_budget",
  description:
    "Initialize the overnight prospect-engine credit + wall-clock budget (800 credits / 45 minutes).",
  inputSchema: {
    type: "object",
    properties: {
      nowMs: { type: "number", description: "Optional clock ms for tests." },
    },
  },
};

export const PROSPECT_ENGINE_CHARGE_CREDITS_DEFINITION: ToolDefinition = {
  name: "prospect_engine_charge_credits",
  description:
    "Fail-closed charge against the run budget. Returns updated budget; sets stopReason without charging when cap or wall clock is hit.",
  inputSchema: {
    type: "object",
    properties: {
      budget: { type: "object", description: "Current budget object." },
      amount: { type: "number", description: "Credits to charge." },
      nowMs: { type: "number" },
    },
    required: ["budget", "amount"],
  },
};

export const PROSPECT_ENGINE_PARSE_LEDGER_DEFINITION: ToolDefinition = {
  name: "prospect_engine_parse_ledger",
  description:
    "Parse durable memory/artifact content into a prospect-engine ledger. Empty or invalid content yields an empty ledger.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        description: "Raw memory_load content (string or object).",
      },
    },
  },
};

export const PROSPECT_ENGINE_MERGE_LEDGER_DEFINITION: ToolDefinition = {
  name: "prospect_engine_merge_ledger",
  description:
    "Merge tonight's accounts + credit log into the ledger. Org keys update in place (O unique orgs).",
  inputSchema: {
    type: "object",
    properties: {
      ledger: { type: "object" },
      runDate: { type: "string" },
      accounts: { type: "array", items: { type: "object" } },
      creditsUsed: { type: "number" },
      stopReason: { type: "string" },
      remainingBalance: { type: "number" },
    },
    required: ["ledger", "runDate", "accounts", "creditsUsed"],
  },
};

export const PROSPECT_ENGINE_DEDUPE_CANDIDATES_DEFINITION: ToolDefinition = {
  name: "prospect_engine_dedupe_candidates",
  description:
    "Filter discover candidates against the ledger, Attio pipeline list orgs, and Engine lane lists.",
  inputSchema: {
    type: "object",
    properties: {
      candidates: { type: "array", items: { type: "object" } },
      ledger: { type: "object" },
      pipelineListResult: { description: "Raw sumble list orgs tool output." },
      growthListResult: { description: "Raw growth list tool output." },
      enterpriseListResult: {
        description: "Raw enterprise list tool output.",
      },
      pipelineOrgIds: {
        type: "array",
        items: { type: "number" },
        description: "Optional explicit pipeline org ids.",
      },
      growthOrgIds: { type: "array", items: { type: "number" } },
      enterpriseOrgIds: { type: "array", items: { type: "number" } },
    },
    required: ["candidates", "ledger"],
  },
};

export const PROSPECT_ENGINE_QUALIFY_DEFINITION: ToolDefinition = {
  name: "prospect_engine_qualify",
  description: "Keep candidates scoring 60+ sorted descending, capped at 15.",
  inputSchema: {
    type: "object",
    properties: {
      candidates: { type: "array", items: { type: "object" } },
      minScore: { type: "number" },
      maxKeep: { type: "number" },
    },
    required: ["candidates"],
  },
};

export const PROSPECT_ENGINE_FORMAT_REPORT_DEFINITION: ToolDefinition = {
  name: "prospect_engine_format_report",
  description:
    "Build nightly markdown table + CSV body and structured artifact data from a scored shortlist.",
  inputSchema: {
    type: "object",
    properties: {
      runDate: { type: "string" },
      accounts: { type: "array", items: { type: "object" } },
      creditsUsed: { type: "number" },
      stopReason: { type: "string" },
    },
    required: ["runDate", "accounts", "creditsUsed"],
  },
};

export const PROSPECT_ENGINE_FORMAT_SLACK_DIGEST_DEFINITION: ToolDefinition = {
  name: "prospect_engine_format_slack_digest",
  description:
    "Build the Slack digest text: top 5 one-liners, lane counts, credits, low-balance warning under 2000.",
  inputSchema: {
    type: "object",
    properties: {
      runDate: { type: "string" },
      accounts: { type: "array", items: { type: "object" } },
      creditsUsed: { type: "number" },
      remainingBudget: { type: "number" },
      sumbleCreditBalance: { type: "number" },
      stopReason: { type: "string" },
      artifactId: { type: "string" },
      runId: { type: "string" },
    },
    required: ["runDate", "accounts", "creditsUsed", "remainingBudget"],
  },
};

export const PROSPECT_ENGINE_FORMAT_MAIL_REFS_DEFINITION: ToolDefinition = {
  name: "prospect_engine_format_mail_refs",
  description:
    "Build mailbox refs linking the nightly artifact and workflow run (heartbeat-style).",
  inputSchema: {
    type: "object",
    properties: {
      artifactId: { type: "string" },
      runId: { type: "string" },
      workflowLabel: { type: "string" },
    },
    required: ["artifactId", "runId"],
  },
};

export const PROSPECT_ENGINE_SERIALIZE_LEDGER_DEFINITION: ToolDefinition = {
  name: "prospect_engine_serialize_ledger",
  description:
    "Serialize a ledger object to a JSON string for write_artifact body.",
  inputSchema: {
    type: "object",
    properties: {
      ledger: { type: "object" },
    },
    required: ["ledger"],
  },
};

export const PROSPECT_ENGINE_EXTRACT_LIST_ORG_IDS_DEFINITION: ToolDefinition = {
  name: "prospect_engine_extract_list_org_ids",
  description:
    "Internal prospect-engine helper. Accept projected list steps (pipeline / growthList / enterpriseList) and return { pipelineOrgIds, growthOrgIds, enterpriseOrgIds } so dedupe never collides on content keys.",
  inputSchema: {
    type: "object",
    additionalProperties: true,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceArgsObject(args: unknown): Record<string, unknown> {
  if (isRecord(args)) return args;
  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args);
      if (isRecord(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }
  return {};
}

function parseCandidates(raw: unknown): ProspectEngineCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: ProspectEngineCandidate[] = [];
  for (const item of raw) {
    const v = ProspectEngineCandidateSchema(item);
    if (!(v instanceof type.errors)) {
      out.push(v);
      continue;
    }
    // Tolerant path: accept minimal { organizationId } from discover JSON.
    if (isRecord(item) && typeof item.organizationId === "number") {
      out.push({
        organizationId: item.organizationId,
        ...item,
      } as ProspectEngineCandidate);
    }
  }
  return out;
}

function parseBudget(raw: unknown): ProspectEngineCreditBudget {
  const v = ProspectEngineCreditBudgetSchema(raw);
  if (v instanceof type.errors) {
    throw new Error(`invalid budget: ${v.summary}`);
  }
  return v;
}

function ok(callId: string, content: string | Record<string, unknown>) {
  return { callId, content };
}

function fail(callId: string, message: string) {
  return { callId, isError: true as const, content: message };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function createInitBudgetTool(): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_INIT_BUDGET_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const nowMs =
        typeof args.nowMs === "number" && Number.isFinite(args.nowMs)
          ? args.nowMs
          : Date.now();
      return ok(call.id, initProspectEngineCreditBudget(nowMs));
    },
  };
}

function createChargeCreditsTool(): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_CHARGE_CREDITS_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      try {
        const budget = parseBudget(args.budget);
        const amount = args.amount;
        if (typeof amount !== "number" || !Number.isFinite(amount)) {
          return fail(call.id, "amount is required");
        }
        const nowMs =
          typeof args.nowMs === "number" && Number.isFinite(args.nowMs)
            ? args.nowMs
            : Date.now();
        const result = chargeProspectEngineCredits(budget, amount, nowMs);
        return ok(call.id, result);
      } catch (err) {
        return fail(call.id, err instanceof Error ? err.message : String(err));
      }
    },
  };
}

function createParseLedgerTool(): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_PARSE_LEDGER_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      // Cold-start / nonFatal artifact_read: tolerate missing body, nested
      // window content, or an isError envelope and return empty ledger.
      let content: unknown = args.content ?? args.body;
      if (isRecord(content) && "content" in content) {
        content = content.content;
      }
      if (isRecord(content) && typeof content.body === "string") {
        content = content.body;
      }
      if (isRecord(content) && typeof content.text === "string") {
        content = content.text;
      }
      const ledger = parseProspectEngineLedger(content);
      return ok(call.id, { ledger });
    },
  };
}

function createMergeLedgerTool(): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_MERGE_LEDGER_DEFINITION,
    handler: async (call) => {
      try {
        const args = coerceArgsObject(call.arguments);
        const ledger = parseProspectEngineLedger(args.ledger);
        const runDate = args.runDate;
        if (typeof runDate !== "string" || runDate.trim().length === 0) {
          return fail(call.id, "runDate is required");
        }
        const accounts = parseCandidates(args.accounts).map((a) => {
          const row: {
            organizationId: number;
            name?: string;
            domain?: string;
            lane?: "growth" | "enterprise";
            score?: number;
            status: "qualified";
          } = {
            organizationId: a.organizationId,
            status: "qualified",
          };
          if (typeof a.name === "string") row.name = a.name;
          if (typeof a.domain === "string") row.domain = a.domain;
          if (a.lane === "growth" || a.lane === "enterprise") row.lane = a.lane;
          if (typeof a.score === "number") row.score = a.score;
          return row;
        });
        const creditsUsed =
          typeof args.creditsUsed === "number" ? args.creditsUsed : 0;
        const mergeInput: Parameters<typeof mergeProspectEngineLedger>[0] = {
          ledger:
            ledger.accounts.length === 0 && ledger.creditLog.length === 0
              ? emptyProspectEngineLedger()
              : ledger,
          runDate,
          accounts,
          creditsUsed,
        };
        if (typeof args.stopReason === "string") {
          mergeInput.stopReason = args.stopReason;
        }
        if (typeof args.remainingBalance === "number") {
          mergeInput.remainingBalance = args.remainingBalance;
        }
        const merged = mergeProspectEngineLedger(mergeInput);
        return ok(call.id, { ledger: merged, content: JSON.stringify(merged) });
      } catch (err) {
        return fail(call.id, err instanceof Error ? err.message : String(err));
      }
    },
  };
}

function createDedupeTool(): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_DEDUPE_CANDIDATES_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const candidates = parseCandidates(args.candidates);
      const ledger: ProspectEngineLedger = parseProspectEngineLedger(
        args.ledger,
      );
      const pipelineOrgIds =
        Array.isArray(args.pipelineOrgIds) && args.pipelineOrgIds.length > 0
          ? (args.pipelineOrgIds as number[])
          : extractOrganizationIds(args.pipelineListResult);
      const growthOrgIds =
        Array.isArray(args.growthOrgIds) && args.growthOrgIds.length > 0
          ? (args.growthOrgIds as number[])
          : extractOrganizationIds(args.growthListResult);
      const enterpriseOrgIds =
        Array.isArray(args.enterpriseOrgIds) && args.enterpriseOrgIds.length > 0
          ? (args.enterpriseOrgIds as number[])
          : extractOrganizationIds(args.enterpriseListResult);

      const result = dedupeProspectCandidates({
        candidates,
        ledger,
        pipelineOrgIds,
        growthOrgIds,
        enterpriseOrgIds,
      });
      return ok(call.id, result);
    },
  };
}

function createQualifyTool(): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_QUALIFY_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const candidates = parseCandidates(args.candidates);
      const minScore =
        typeof args.minScore === "number" ? args.minScore : undefined;
      const maxKeep =
        typeof args.maxKeep === "number" ? args.maxKeep : undefined;
      const qualified = qualifyProspects(candidates, minScore, maxKeep);
      return ok(call.id, {
        accounts: qualified,
        growthOrganizationIds: qualified
          .filter((a) => a.lane === "growth")
          .map((a) => a.organizationId),
        enterpriseOrganizationIds: qualified
          .filter((a) => a.lane === "enterprise")
          .map((a) => a.organizationId),
      });
    },
  };
}

function createFormatReportTool(): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_FORMAT_REPORT_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const runDate = args.runDate;
      if (typeof runDate !== "string") {
        return fail(call.id, "runDate is required");
      }
      const accounts = parseCandidates(args.accounts);
      const creditsUsed =
        typeof args.creditsUsed === "number" ? args.creditsUsed : 0;
      const reportInput: {
        runDate: string;
        accounts: ProspectEngineCandidate[];
        creditsUsed: number;
        stopReason?: string;
        thinNight?: boolean;
      } = {
        runDate,
        accounts,
        creditsUsed,
        thinNight: accounts.length < 5,
      };
      if (typeof args.stopReason === "string") {
        reportInput.stopReason = args.stopReason;
      }
      const markdown = buildProspectEngineReportMarkdown(reportInput);
      const csv = buildProspectEngineReportCsv(accounts);
      const body = `${markdown}\n\n## CSV\n\n\`\`\`csv\n${csv}\n\`\`\`\n`;
      // Always emit creditsUsed + stopReason so downstream argMaps never hit
      // optional-skip (missing optional keys skip the entire deterministic step).
      return ok(call.id, {
        body,
        markdown,
        csv,
        reportMarkdown: body,
        growthOrganizationIds: accounts
          .filter((a) => a.lane === "growth")
          .map((a) => a.organizationId),
        enterpriseOrganizationIds: accounts
          .filter((a) => a.lane === "enterprise")
          .map((a) => a.organizationId),
        accounts,
        creditsUsed,
        stopReason:
          typeof args.stopReason === "string" ? args.stopReason : null,
      });
    },
  };
}

function createFormatSlackDigestTool(): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_FORMAT_SLACK_DIGEST_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const runDate = args.runDate;
      if (typeof runDate !== "string") {
        return fail(call.id, "runDate is required");
      }
      const accounts = parseCandidates(args.accounts);
      const creditsUsed =
        typeof args.creditsUsed === "number" ? args.creditsUsed : 0;
      // Prefer explicit remaining; otherwise derive from run cap − used.
      // (initBudget.remaining is always the full cap and is not a live counter.)
      const remainingBudget =
        typeof args.remainingBudget === "number" &&
        args.remainingBudget < PROSPECT_ENGINE_CREDIT_CAP
          ? args.remainingBudget
          : Math.max(0, PROSPECT_ENGINE_CREDIT_CAP - creditsUsed);
      const digestInput: {
        runDate: string;
        accounts: ProspectEngineCandidate[];
        creditsUsed: number;
        remainingBudget: number;
        sumbleCreditBalance?: number;
        stopReason?: string;
        artifactId?: string;
        runId?: string;
      } = {
        runDate,
        accounts,
        creditsUsed,
        remainingBudget,
      };
      if (typeof args.sumbleCreditBalance === "number") {
        digestInput.sumbleCreditBalance = args.sumbleCreditBalance;
      }
      if (typeof args.stopReason === "string") {
        digestInput.stopReason = args.stopReason;
      }
      if (typeof args.artifactId === "string") {
        digestInput.artifactId = args.artifactId;
      }
      if (typeof args.runId === "string") {
        digestInput.runId = args.runId;
      }
      const text = formatProspectEngineSlackDigest(digestInput);
      return ok(call.id, { text, reply: text });
    },
  };
}

function createFormatMailRefsTool(): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_FORMAT_MAIL_REFS_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const artifactId = args.artifactId;
      const runId = args.runId;
      if (typeof artifactId !== "string" || artifactId.trim().length === 0) {
        return fail(call.id, "artifactId is required");
      }
      if (typeof runId !== "string" || runId.trim().length === 0) {
        return fail(call.id, "runId is required");
      }
      try {
        const refs =
          typeof args.workflowLabel === "string"
            ? prospectEngineMailRefs(artifactId, runId, args.workflowLabel)
            : prospectEngineMailRefs(artifactId, runId);
        return ok(call.id, { refs });
      } catch (err) {
        return fail(call.id, err instanceof Error ? err.message : String(err));
      }
    },
  };
}

function createSerializeLedgerTool(): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_SERIALIZE_LEDGER_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const ledger = parseProspectEngineLedger(args.ledger);
      const content = JSON.stringify(ledger);
      return ok(call.id, { content, ledger });
    },
  };
}

function createExtractListOrgIdsTool(): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_EXTRACT_LIST_ORG_IDS_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      // Heartbeat-style projected steps: { stepId: { output: ToolResult } }
      const stepContent = (stepId: string): unknown => {
        const step = args[stepId];
        if (!isRecord(step)) return undefined;
        const output = step.output;
        if (!isRecord(output)) return output;
        return "content" in output ? output.content : output;
      };
      return ok(call.id, {
        pipelineOrgIds: extractOrganizationIds(
          stepContent("pipeline") ?? args.pipelineListResult,
        ),
        growthOrgIds: extractOrganizationIds(
          stepContent("growthList") ?? args.growthListResult,
        ),
        enterpriseOrgIds: extractOrganizationIds(
          stepContent("enterpriseList") ?? args.enterpriseListResult,
        ),
      });
    },
  };
}

/** Stateless prospect-engine hub tools (no credential, no host context). */
export function createProspectEngineTools(): AgentTool[] {
  return [
    createInitBudgetTool(),
    createChargeCreditsTool(),
    createParseLedgerTool(),
    createMergeLedgerTool(),
    createDedupeTool(),
    createQualifyTool(),
    createFormatReportTool(),
    createFormatSlackDigestTool(),
    createFormatMailRefsTool(),
    createSerializeLedgerTool(),
    createExtractListOrgIdsTool(),
  ];
}
