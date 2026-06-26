import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";
import {
  buildReport,
  entityExtract,
  ResearchItem,
  type SkippedSource,
} from "@workbench/last30days-core";

export const LAST30DAYS_CORE_EXTRACT_DEFINITION: ToolDefinition = {
  name: "last30days_core_extract",
  description:
    "Extract entities (handles, repos, subreddits, hashtags, keywords) from a topic string.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Topic string to extract entities from.",
      },
    },
    required: ["topic"],
  },
};

export const LAST30DAYS_CORE_REPORT_DEFINITION: ToolDefinition = {
  name: "last30days_core_report",
  description:
    "Build a structured research brief from raw ResearchItems. Applies date filter, dedupe, cluster-merge, and rank scoring, and returns ranked clusters, stats, a lead headline, best-takes, items, and citations. Pass the returned object verbatim as write_artifact { data } for rich rendering.",
  inputSchema: {
    type: "object",
    properties: {
      rawItems: {
        type: "array",
        items: { type: "object" },
        description: "Array of ResearchItem objects to process.",
      },
      topic: { type: "string", description: "Topic label for the report." },
      days: {
        type: "number",
        description:
          "Number of days to include in the date window. Defaults to 30.",
      },
      topK: {
        type: "number",
        description: "Maximum number of top items to include. Defaults to 20.",
      },
    },
    required: ["rawItems", "topic"],
  },
};

export const LAST30DAYS_WORKFLOW_BRIEF_DEFINITION: ToolDefinition = {
  name: "last30days_workflow_brief",
  description:
    "Build a structured last30days brief from workflow step outputs. Internal workflow helper that parses source tool result envelopes.",
  inputSchema: {
    type: "object",
    additionalProperties: true,
  },
};

export const LAST30DAYS_GROUND_QUERIES_DEFINITION: ToolDefinition = {
  name: "last30days_ground_queries",
  description:
    "Internal workflow helper. Parse the grounding step's JSON reply into a per-source query map so each source fan-out gets a query tailored to that platform. Every source key is guaranteed a non-empty string (falling back to the base query) so a thin or malformed grounding reply never blanks a source search.",
  inputSchema: {
    type: "object",
    additionalProperties: true,
  },
};

export const LAST30DAYS_VALIDATE_DEFINITION: ToolDefinition = {
  name: "last30days_validate",
  description:
    "Validate a report body against its citations. (Stub — full validation is CL-1569.)",
  inputSchema: {
    type: "object",
    properties: {
      body: { type: "string", description: "Report body to validate." },
      citations: {
        type: "array",
        items: { type: "object" },
        description: "Citations to check against.",
      },
      returnedItemUrls: {
        type: "array",
        items: { type: "string" },
        description: "URLs of items returned from research.",
      },
    },
    required: ["body", "citations", "returnedItemUrls"],
  },
};

function coerceArgsObject(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof args._raw === "string") {
    const parsed: unknown = JSON.parse(args._raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("_raw fallback is not a JSON object");
    }
    return parsed as Record<string, unknown>;
  }
  return args;
}

function createExtractTool(): AgentTool {
  return {
    kind: "string",
    definition: LAST30DAYS_CORE_EXTRACT_DEFINITION,
    handler: async (args) => {
      const effective = coerceArgsObject(args);
      const topic = effective.topic;
      if (typeof topic !== "string" || topic.trim().length === 0) {
        throw new Error("topic is required");
      }
      return JSON.stringify(entityExtract(topic));
    },
  };
}

function readRawItems(rawItemsInput: unknown): (typeof ResearchItem.infer)[] {
  let effective = rawItemsInput;
  if (typeof effective === "string") {
    const parsed: unknown = JSON.parse(effective);
    if (!Array.isArray(parsed)) {
      throw new Error("rawItems stringified value is not an array");
    }
    effective = parsed;
  }
  if (!Array.isArray(effective)) {
    throw new Error("rawItems must be an array");
  }
  return effective.map((item: unknown, i: number) => {
    const validated = ResearchItem(item);
    if (validated instanceof type.errors) {
      throw new Error(`rawItems[${i}] is invalid: ${String(validated)}`);
    }
    return validated;
  });
}

function createReportTool(): AgentTool {
  return {
    kind: "string",
    definition: LAST30DAYS_CORE_REPORT_DEFINITION,
    handler: async (args) => {
      const effective = coerceArgsObject(args);
      const topic = effective.topic;
      if (typeof topic !== "string" || topic.trim().length === 0) {
        throw new Error("topic is required");
      }
      const rawItems = readRawItems(effective.rawItems);
      const days = typeof effective.days === "number" ? effective.days : 30;
      const topK = typeof effective.topK === "number" ? effective.topK : 20;
      const nowIso = new Date().toISOString();
      return JSON.stringify(
        buildReport(rawItems, { topic, days, topK, nowIso }),
      );
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type SourceParse =
  | { ok: true; items: unknown[] }
  | { ok: false; reason: string };

// A failed source's content can be a multi-KB error body (HTML page, stack
// trace). The reason is persisted in the brief and fed to the writer LLM, so
// cap it to keep the payload and prompt bounded.
const MAX_REASON_DETAIL = 200;
function truncateDetail(detail: string): string {
  return detail.length > MAX_REASON_DETAIL
    ? `${detail.slice(0, MAX_REASON_DETAIL)}… (${detail.length} chars)`
    : detail;
}

/**
 * A source step's result is an `{ output: { content, isError? } }` envelope.
 * A failed source (rate-limit/auth/network) arrives as a plain-text `isError`
 * envelope, not JSON — so parsing must degrade to a recorded skip, never throw.
 * One failed source must not poison the brief for the others.
 */
function parseSourceStep(step: unknown): SourceParse {
  const output = isRecord(step) ? step.output : undefined;
  if (!isRecord(output)) return { ok: true, items: [] };
  const content = output.content;
  if (output.isError === true) {
    const detail =
      typeof content === "string" && content.trim().length > 0
        ? truncateDetail(content)
        : "tool reported an error";
    return { ok: false, reason: `source errored: ${detail}` };
  }
  // Every source today is a string tool returning JSON.stringify(...), so
  // non-string content means "nothing to read" (a `full` tool returning object
  // content would land here — revisit if one is ever added).
  if (typeof content !== "string" || content.trim().length === 0) {
    return { ok: true, items: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: `non-JSON content: ${reason}` };
  }
  return { ok: true, items: collectItems(parsed) };
}

function collectValidItems(raw: unknown[]): {
  items: (typeof ResearchItem.infer)[];
  invalidCount: number;
} {
  const items: (typeof ResearchItem.infer)[] = [];
  let invalidCount = 0;
  for (const candidate of raw) {
    const validated = ResearchItem(candidate);
    if (validated instanceof type.errors) {
      invalidCount += 1;
      continue;
    }
    items.push(validated);
  }
  return { items, invalidCount };
}

function collectItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["items", "results", "rawItems"]) {
    const maybeItems = value[key];
    if (Array.isArray(maybeItems)) return maybeItems;
  }
  return [];
}

const SOURCE_STEP_IDS = [
  "hackernews",
  "github",
  "web",
  "reddit",
  "x",
  "youtube",
  "polymarket",
  "bluesky",
] as const;

// Relevance floor for the workflow brief: drop clusters the rerank/grounding
// scored below 40 (off-topic on the reference 0–100 scale) instead of padding
// topK with noise. A thin topic then yields an honestly-small brief. See
// buildReport's `minRelevance`.
const BRIEF_MIN_RELEVANCE = 40;

// The LLM rerank step (W1.2) emits a `reply` string of JSON relevance scores by
// url. Parse it tolerantly (tolerate code fences / surrounding prose); a missing
// or malformed reply yields an empty map and the brief falls back to the
// deterministic grounding in rankScore.
function parseRerankScores(step: unknown): Map<string, number> {
  const scores = new Map<string, number>();
  const output = isRecord(step) ? step.output : undefined;
  const reply = isRecord(output) ? output.reply : undefined;
  if (typeof reply !== "string") return scores;
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return scores;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return scores;
  }
  const list =
    isRecord(parsed) && Array.isArray(parsed.scores) ? parsed.scores : [];
  for (const entry of list) {
    if (
      isRecord(entry) &&
      typeof entry.url === "string" &&
      typeof entry.relevance === "number" &&
      Number.isFinite(entry.relevance)
    ) {
      scores.set(entry.url, Math.max(0, Math.min(entry.relevance, 100)));
    }
  }
  return scores;
}

// The fan-out sources whose search query the grounding step tailors. Mirrors the
// workflow's `SOURCES` keys (the workflow is the fan-out source of truth; a key
// here that the workflow drops, or vice versa, degrades that source to the base
// query rather than erroring). Bluesky stays disabled upstream. Exported so the
// parse contract is inspectable.
export const GROUNDING_SOURCE_KEYS = [
  "hackernews",
  "github",
  "web",
  "reddit",
  "x",
  "youtube",
  "polymarket",
] as const;

// Parse the grounding LLM reply (tolerant of code fences / surrounding prose)
// into a per-source query map. Every key is filled: the per-source string the
// model returned when it is non-empty, else the base query — so a malformed or
// partial reply degrades to the untailored query rather than blanking a source.
function parseGroundedQueries(
  reply: unknown,
  baseQuery: string,
): Record<string, string> {
  const tailored = new Map<string, string>();
  if (typeof reply === "string") {
    const start = reply.indexOf("{");
    const end = reply.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
        if (isRecord(parsed)) {
          for (const key of GROUNDING_SOURCE_KEYS) {
            const value = parsed[key];
            if (typeof value === "string" && value.trim().length > 0) {
              tailored.set(key, value.trim());
            }
          }
        }
      } catch {
        // fall through to base-query defaults
      }
    }
  }
  const queries: Record<string, string> = {};
  for (const key of GROUNDING_SOURCE_KEYS) {
    queries[key] = tailored.get(key) ?? baseQuery;
  }
  return queries;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

// Returns object `content` (not a JSON string) so each source step can select
// its tailored query by field: `steps.groundQueries.output.content.<source>`.
function createGroundQueriesTool(): AgentTool {
  return {
    kind: "full",
    definition: LAST30DAYS_GROUND_QUERIES_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const baseQuery =
        readNonEmptyString(args.query) ?? readNonEmptyString(args.topic);
      if (baseQuery === undefined) {
        throw new Error(
          "last30days_ground_queries requires a non-empty query or topic",
        );
      }
      return {
        callId: call.id,
        content: parseGroundedQueries(args.reply, baseQuery),
      };
    },
  };
}

function createWorkflowBriefTool(): AgentTool {
  return {
    kind: "string",
    definition: LAST30DAYS_WORKFLOW_BRIEF_DEFINITION,
    handler: async (args) => {
      const steps = coerceArgsObject(args);
      const intake =
        isRecord(steps.intake) && isRecord(steps.intake.output)
          ? steps.intake.output
          : {};
      const topic =
        typeof intake.topic === "string" && intake.topic.trim().length > 0
          ? intake.topic
          : undefined;
      if (topic === undefined) {
        throw new Error("workflow intake output must include topic");
      }
      const days =
        typeof intake.days === "number" && Number.isFinite(intake.days)
          ? intake.days
          : 30;
      const rawItems: (typeof ResearchItem.infer)[] = [];
      const skippedSources: SkippedSource[] = [];
      for (const stepId of SOURCE_STEP_IDS) {
        const result = parseSourceStep(steps[stepId]);
        if (!result.ok) {
          skippedSources.push({
            source: stepId,
            kind: "source-error",
            reason: result.reason,
          });
          continue;
        }
        const { items, invalidCount } = collectValidItems(result.items);
        rawItems.push(...items);
        if (invalidCount > 0) {
          skippedSources.push({
            source: stepId,
            kind: "invalid-items",
            reason: `${invalidCount} item(s) failed schema validation`,
          });
        }
      }
      // Apply LLM rerank relevance (W1.2) onto items by url; rankScore treats an
      // explicit relevance as the dominant signal over the deterministic ground.
      const rerankScores = parseRerankScores(steps.rerank);
      if (rerankScores.size > 0) {
        for (const item of rawItems) {
          const score = rerankScores.get(item.url);
          if (score !== undefined) item.relevance = score;
        }
      }
      const nowIso = new Date().toISOString();
      return JSON.stringify(
        buildReport(rawItems, {
          topic,
          days,
          topK: 20,
          nowIso,
          minRelevance: BRIEF_MIN_RELEVANCE,
          skippedSources,
        }),
      );
    },
  };
}

function createValidateTool(): AgentTool {
  return {
    kind: "string",
    definition: LAST30DAYS_VALIDATE_DEFINITION,
    handler: async (args) => {
      const body = args.body;
      if (typeof body !== "string") {
        throw new Error("body is required");
      }
      return JSON.stringify({ ok: true, body });
    },
  };
}

/** The stateless last30days core tools (no credential, no host context). */
export function createLast30daysTools(): AgentTool[] {
  return [
    createExtractTool(),
    createReportTool(),
    createGroundQueriesTool(),
    createWorkflowBriefTool(),
    createValidateTool(),
  ];
}
