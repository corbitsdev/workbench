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
  mergeProspectEngineShortlist,
  parseProspectEngineLedger,
  prospectEngineMailRefs,
  qualifyProspects,
  sanitizeProspectEngineContacts,
} from "@workbench/shared";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const PROSPECT_ENGINE_INIT_BUDGET_DEFINITION: ToolDefinition = {
  name: "prospect_engine_init_budget",
  description:
    "Initialize the overnight prospect-engine credit + wall-clock budget (800 credits / 45 minutes). Returns budgetId for durable cross-step charging.",
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
    "Fail-closed charge against the run budget. Prefer budgetId from init_budget (durable across steps). Returns updated budget; sets stopReason without charging when cap or wall clock is hit.",
  inputSchema: {
    type: "object",
    properties: {
      budgetId: {
        type: "string",
        description: "Durable budget id from init_budget (preferred).",
      },
      budget: {
        type: "object",
        description: "Inline budget object (fallback when budgetId missing).",
      },
      amount: { type: "number", description: "Credits to charge." },
      nowMs: { type: "number" },
    },
    required: ["amount"],
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
    "Build nightly markdown table + CSV body and structured artifact data. Merges baseAccounts (qualify shortlist) with accounts (map enrichments) so delivery never depends solely on the map agent.",
  inputSchema: {
    type: "object",
    properties: {
      runDate: { type: "string" },
      baseAccounts: {
        type: "array",
        items: { type: "object" },
        description: "Qualified shortlist (membership + order).",
      },
      accounts: {
        type: "array",
        items: { type: "object" },
        description:
          "Map/reveal overlay or full shortlist when baseAccounts omitted.",
      },
      budgetId: {
        type: "string",
        description: "Durable budget id — preferred source of creditsUsed.",
      },
      creditsUsed: { type: "number" },
      stopReason: { type: "string" },
    },
    required: ["runDate"],
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

// A native `action` selector (`from`/`project`/`merge`/`literal`) can read a
// dot path or rename nothing — it cannot JSON.parse an agent's `reply` string
// and pull a nested field out of it (CL-4454, prospect-engine has no native
// equivalent of deterministicToolStep's `fromJson` argMap). Both
// `prospect_engine_dedupe_candidates` and `prospect_engine_qualify` need the
// discover/score agents' `{"candidates": [...]}` JSON reply unwrapped into a
// plain `candidates` array before they ever run; this is the one shaping tool
// that does it, reused by both call sites, single caller (this workflow).
export const PROSPECT_ENGINE_EXTRACT_CANDIDATES_FROM_REPLY_DEFINITION: ToolDefinition =
  {
    name: "prospect_engine_extract_candidates_from_reply",
    description:
      "Parse an agent's JSON reply (discover or score) and extract its candidates array. Fatal (throws) when the reply is absent or unparseable — dedupe/qualify cannot run without a shortlist.",
    inputSchema: {
      type: "object",
      properties: {
        reply: {
          type: "string",
          description:
            "Raw agent reply, expected to be JSON with a candidates array.",
        },
      },
      required: ["reply"],
    },
  };

// Mirrors the `accounts` / `creditsCharged` / `stopReason` unwrap the map/
// reveal agent's JSON reply needs before `prospect_engine_format_report`
// reads it — but tolerant, not fatal: the original deterministicToolStep
// argMap marked all three `optional: true` (a thin/failed map still delivers
// the qualified shortlist via `baseAccounts`), so an absent or unparseable
// reply here returns `{}` rather than throwing.
export const PROSPECT_ENGINE_EXTRACT_MAP_REVEAL_OVERLAY_DEFINITION: ToolDefinition =
  {
    name: "prospect_engine_extract_map_reveal_overlay",
    description:
      "Parse the map/reveal agent's JSON reply into { accounts?, creditsUsed?, stopReason? }. Tolerant: an absent or unparseable reply returns {} so format_report still runs off baseAccounts alone.",
    inputSchema: {
      type: "object",
      properties: {
        reply: { type: "string" },
      },
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
      const sanitizedContacts = sanitizeProspectEngineContacts(v.contacts);
      out.push({
        ...v,
        ...(sanitizedContacts !== undefined
          ? { contacts: sanitizedContacts }
          : {}),
      });
      continue;
    }
    // Tolerant path: accept minimal { organizationId } from discover JSON.
    if (isRecord(item) && typeof item.organizationId === "number") {
      const contacts = Array.isArray(item.contacts)
        ? sanitizeProspectEngineContacts(
            item.contacts as ProspectEngineCandidate["contacts"],
          )
        : undefined;
      out.push({
        organizationId: item.organizationId,
        ...item,
        ...(contacts !== undefined ? { contacts } : {}),
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
// Durable run-scoped budget store (process-local, survives across steps)
// ---------------------------------------------------------------------------

export type ProspectEngineBudgetStore = {
  get(budgetId: string): ProspectEngineCreditBudget | undefined;
  set(budgetId: string, budget: ProspectEngineCreditBudget): void;
};

export function createInMemoryProspectEngineBudgetStore(): ProspectEngineBudgetStore {
  const map = new Map<string, ProspectEngineCreditBudget>();
  return {
    get: (id) => map.get(id),
    set: (id, budget) => {
      map.set(id, budget);
    },
  };
}

/** Hub process singleton so charges accumulate across workflow steps. */
const defaultBudgetStore = createInMemoryProspectEngineBudgetStore();

export type CreateProspectEngineToolsOpts = {
  budgetStore?: ProspectEngineBudgetStore;
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function createInitBudgetTool(store: ProspectEngineBudgetStore): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_INIT_BUDGET_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const nowMs =
        typeof args.nowMs === "number" && Number.isFinite(args.nowMs)
          ? args.nowMs
          : Date.now();
      const budget = initProspectEngineCreditBudget(nowMs);
      const budgetId = randomUUID();
      store.set(budgetId, budget);
      return ok(call.id, { budgetId, ...budget });
    },
  };
}

function createChargeCreditsTool(store: ProspectEngineBudgetStore): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_CHARGE_CREDITS_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      try {
        const amount = args.amount;
        if (typeof amount !== "number" || !Number.isFinite(amount)) {
          return fail(call.id, "amount is required");
        }
        const budgetId =
          typeof args.budgetId === "string" && args.budgetId.length > 0
            ? args.budgetId
            : null;

        let budget: ProspectEngineCreditBudget;
        if (budgetId !== null) {
          const stored = store.get(budgetId);
          if (stored) {
            budget = stored;
          } else if (args.budget !== undefined) {
            // Store miss (hub restart mid-run): fall back to inline budget.
            budget = parseBudget(args.budget);
          } else {
            return fail(
              call.id,
              `Unknown budgetId ${budgetId} and no inline budget provided`,
            );
          }
        } else {
          budget = parseBudget(args.budget);
        }

        // Prefer server wall-clock so agents cannot soft-bypass by freezing nowMs.
        // Tests may still pass nowMs to advance the clock deterministically.
        const nowMs =
          typeof args.nowMs === "number" && Number.isFinite(args.nowMs)
            ? args.nowMs
            : Date.now();
        const result = chargeProspectEngineCredits(budget, amount, nowMs);
        if (budgetId !== null) {
          store.set(budgetId, result.budget);
        }
        return ok(call.id, {
          ...result,
          budgetId,
          // Convenience aliases for agents/argMaps
          charged: result.charged,
          remaining: result.budget.remaining,
          used: result.budget.used,
          stopReason: result.stopReason ?? result.budget.stopReason ?? null,
        });
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
        const serialized = JSON.stringify(merged);
        return ok(call.id, {
          ledger: merged,
          // write_artifact (a tool shared across every workflow) always
          // names its arg `body`; emit it directly rather than aliasing a
          // separately-named `content` field (CL-4454, single caller).
          body: serialized,
        });
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
        // Alias so format_report's native `action` step can read the
        // qualified shortlist as `baseAccounts` directly — the map/reveal
        // overlay also emits an `accounts` field, and a flat merge of both
        // steps' outputs would collide on that key (CL-4454). Single
        // caller (this workflow), so aliasing here beats a reshape step.
        baseAccounts: qualified,
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

function createFormatReportTool(store: ProspectEngineBudgetStore): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_FORMAT_REPORT_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const runDate = args.runDate;
      if (typeof runDate !== "string") {
        return fail(call.id, "runDate is required");
      }

      // Prefer baseAccounts (qualify shortlist) + accounts (map overlay).
      // When baseAccounts is absent, treat accounts as the full shortlist.
      const baseAccounts =
        args.baseAccounts !== undefined
          ? parseCandidates(args.baseAccounts)
          : parseCandidates(args.accounts);
      const overlay =
        args.baseAccounts !== undefined ? parseCandidates(args.accounts) : [];
      const accounts =
        args.baseAccounts !== undefined
          ? mergeProspectEngineShortlist(baseAccounts, overlay)
          : baseAccounts;

      // Prefer durable budgetId for creditsUsed (survives agent soft-state).
      let creditsUsed =
        typeof args.creditsUsed === "number" ? args.creditsUsed : 0;
      let stopReason: string | null =
        typeof args.stopReason === "string" ? args.stopReason : null;
      if (typeof args.budgetId === "string" && args.budgetId.length > 0) {
        const b = store.get(args.budgetId);
        if (b) {
          creditsUsed = b.used;
          if (b.stopReason) stopReason = b.stopReason;
        }
      }

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
      if (stopReason !== null) {
        reportInput.stopReason = stopReason;
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
        stopReason,
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

// Tolerant by construction (CL-4464): mailRefs is a best-effort deep-link
// builder ahead of a native `action` step (`ActionPrimitive` has no
// error-swallow), so a missing artifactId/runId or a thrown builder error
// never becomes an `isError` `ToolResult` — it returns `{ isError: true,
// error }` as ordinary content instead. `mail`'s downstream argMap-free
// merge already tolerates an absent `refs` field.
function createFormatMailRefsTool(): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_FORMAT_MAIL_REFS_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const artifactId = args.artifactId;
      const runId = args.runId;
      if (typeof artifactId !== "string" || artifactId.trim().length === 0) {
        return ok(call.id, { isError: true, error: "artifactId is required" });
      }
      if (typeof runId !== "string" || runId.trim().length === 0) {
        return ok(call.id, { isError: true, error: "runId is required" });
      }
      try {
        const refs =
          typeof args.workflowLabel === "string"
            ? prospectEngineMailRefs(artifactId, runId, args.workflowLabel)
            : prospectEngineMailRefs(artifactId, runId);
        return ok(call.id, { refs });
      } catch (err) {
        return ok(call.id, {
          isError: true,
          error: err instanceof Error ? err.message : String(err),
        });
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

function createExtractCandidatesFromReplyTool(): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_EXTRACT_CANDIDATES_FROM_REPLY_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const reply = args.reply;
      if (typeof reply !== "string" || reply.trim().length === 0) {
        return fail(call.id, "reply is required");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(reply);
      } catch (err) {
        return fail(
          call.id,
          `reply is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) {
        return fail(call.id, "reply JSON has no candidates array");
      }
      return ok(call.id, { candidates: parsed.candidates });
    },
  };
}

function createExtractMapRevealOverlayTool(): AgentTool {
  return {
    kind: "full",
    definition: PROSPECT_ENGINE_EXTRACT_MAP_REVEAL_OVERLAY_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const reply = args.reply;
      if (typeof reply !== "string" || reply.trim().length === 0) {
        return ok(call.id, {});
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(reply);
      } catch {
        return ok(call.id, {});
      }
      if (!isRecord(parsed)) {
        return ok(call.id, {});
      }
      const overlay: {
        accounts?: unknown;
        creditsUsed?: number;
        stopReason?: string;
      } = {};
      if (Array.isArray(parsed.accounts)) overlay.accounts = parsed.accounts;
      if (typeof parsed.creditsCharged === "number") {
        overlay.creditsUsed = parsed.creditsCharged;
      }
      if (typeof parsed.stopReason === "string") {
        overlay.stopReason = parsed.stopReason;
      }
      return ok(call.id, overlay);
    },
  };
}

/** Prospect-engine hub tools. Budget store is process-local so charges accumulate across steps. */
export function createProspectEngineTools(
  opts?: CreateProspectEngineToolsOpts,
): AgentTool[] {
  const store = opts?.budgetStore ?? defaultBudgetStore;
  return [
    createInitBudgetTool(store),
    createChargeCreditsTool(store),
    createParseLedgerTool(),
    createMergeLedgerTool(),
    createDedupeTool(),
    createQualifyTool(),
    createFormatReportTool(store),
    createFormatSlackDigestTool(),
    createFormatMailRefsTool(),
    createSerializeLedgerTool(),
    createExtractListOrgIdsTool(),
    createExtractCandidatesFromReplyTool(),
    createExtractMapRevealOverlayTool(),
  ];
}
