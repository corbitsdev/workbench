import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";
import {
  buildReport,
  buildReportFromCuration,
  coerceCuration,
  dateFilter,
  dedupe,
  entityExtract,
  normalizeIntake,
  qualityFilter,
  ResearchItem,
  SkippedSource,
} from "@workbench/last30days-core";
import {
  formatHeartbeatBriefDocument,
  formatHeartbeatBriefTitle,
  mergeHeartbeatBriefSources,
  morningBriefNotifyMail,
} from "@workbench/shared";

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

export const LAST30DAYS_FORMAT_REPORT_DOCUMENT_DEFINITION: ToolDefinition = {
  name: "last30days_format_report_document",
  description:
    "Internal workflow helper. Pairs the intake topic with the writer agent's reply into the { title, body } shape write_artifact expects, so the persist step never reshapes the agent's reply field.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description:
          "The research topic from intake, used as the artifact title.",
      },
      reply: {
        type: "string",
        description: "The writer agent's synthesized report text.",
      },
    },
    required: ["topic", "reply"],
  },
};

export const COMPETITOR_ANALYSIS_FORMAT_REPORT_DOCUMENT_DEFINITION: ToolDefinition =
  {
    name: "competitor_analysis_format_report_document",
    description:
      "Internal workflow helper. Pairs the researched company's URL with the synthesize agent's reply into the { title, body } shape write_artifact expects, so the persist step never reshapes the agent's reply field.",
    inputSchema: {
      type: "object",
      properties: {
        companyUrl: {
          type: "string",
          description:
            "The researched company's URL, used as the artifact title.",
        },
        reply: {
          type: "string",
          description: "The synthesize agent's competitor report text.",
        },
      },
      required: ["companyUrl", "reply"],
    },
  };

export const SUMBLE_ACCOUNT_INTEL_FORMAT_REPORT_DOCUMENT_DEFINITION: ToolDefinition =
  {
    name: "sumble_account_intel_format_report_document",
    description:
      "Internal workflow helper. Pairs the researched account's organization domain with the synthesize agent's reply into the { title, body } shape write_artifact expects, so the persist step never reshapes the agent's reply field.",
    inputSchema: {
      type: "object",
      properties: {
        organizationDomain: {
          type: "string",
          description:
            "The researched account's organization domain, used as the artifact title.",
        },
        reply: {
          type: "string",
          description:
            "The synthesize agent's account intelligence brief text.",
        },
      },
      required: ["organizationDomain", "reply"],
    },
  };

export const FIRECRAWL_URL_WATCH_FORMAT_DOCUMENT_DEFINITION: ToolDefinition = {
  name: "firecrawl_url_watch_format_document",
  description:
    "Internal workflow helper. Pairs the watched URL with the digest agent's reply into the { title, body } shape write_artifact expects, so the persist step never reshapes the agent's reply field.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The watched URL from intake, used as the artifact title.",
      },
      reply: {
        type: "string",
        description: "The digest agent's synthesized digest text.",
      },
    },
    required: ["url", "reply"],
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

export const LAST30DAYS_COLLECT_DEFINITION: ToolDefinition = {
  name: "last30days_collect",
  description:
    "Internal workflow helper. Parse every source step's result envelope (both research rounds), date-filter, dedupe, and structural-junk-filter the candidates, and return a single clean { topic, days, items, skippedSources } object for the LLM curate step to judge.",
  inputSchema: {
    type: "object",
    additionalProperties: true,
  },
};

export const HEARTBEAT_MERGE_BRIEF_SOURCES_DEFINITION: ToolDefinition = {
  name: "heartbeat_merge_brief_sources",
  description:
    "Internal heartbeat workflow helper. Parse each intake step's tool envelope and return { sources: { granola, linear, attio, vercel } } so the brief step sees every source without merge collisions on callId/content/isError.",
  inputSchema: {
    type: "object",
    additionalProperties: true,
  },
};

export const HEARTBEAT_FORMAT_BRIEF_NOTIFY_DEFINITION: ToolDefinition = {
  name: "heartbeat_format_brief_notify",
  description:
    "Internal heartbeat workflow helper. Builds the morning-brief notify mail's exact mail_send argument shape ({ to, subject, content, refs }) from the firing user's address, the composed brief document, and the persisted artifact id, so the notify step reads this tool's output verbatim.",
  inputSchema: {
    type: "object",
    properties: {
      userAddress: {
        type: "string",
        description: "The firing user's usr_ mail address.",
      },
      title: {
        type: "string",
        description: "The brief's display title (mail subject).",
      },
      body: {
        type: "string",
        description: "The brief's body (mail content).",
      },
      artifactId: {
        type: "string",
        description: "Persisted morning-brief artifact id from write_artifact.",
      },
      runId: {
        type: "string",
        description:
          "Workflow run id from the hub trigger payload (same as mail messageId).",
      },
      workflowLabel: {
        type: "string",
        description:
          "Display label for the workflow_run ref (defaults to Company Heartbeat).",
      },
    },
    required: ["userAddress", "title", "body", "artifactId", "runId"],
  },
};

export const HEARTBEAT_FORMAT_BRIEF_DOCUMENT_DEFINITION: ToolDefinition = {
  name: "heartbeat_format_brief_document",
  description:
    "Internal heartbeat workflow helper. Pairs the title step's title with the brief agent's reply into the { title, body } shape write_artifact and the notify-mail step expect, so neither downstream step reshapes the agent's reply field.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "The brief's display title from heartbeat_format_brief_title.",
      },
      reply: {
        type: "string",
        description: "The brief agent's synthesized reply text.",
      },
    },
    required: ["title", "reply"],
  },
};

export const HEARTBEAT_FORMAT_BRIEF_TITLE_DEFINITION: ToolDefinition = {
  name: "heartbeat_format_brief_title",
  description:
    'Internal heartbeat workflow helper. Formats the morning brief\'s display name as "<User>\'s Morning Brief - DD/MM/YY" (falls back to "Your Morning Brief - DD/MM/YY" when no display name is known), for use as both the notify mail subject and the persisted artifact title.',
  inputSchema: {
    type: "object",
    properties: {
      userDisplayName: {
        type: "string",
        description: "The firing user's display name, if known.",
      },
    },
  },
};

export const LAST30DAYS_ENTITY_QUERIES_DEFINITION: ToolDefinition = {
  name: "last30days_entity_queries",
  description:
    "Internal workflow helper. Parse the entity-extraction step's JSON reply into a per-source query map (web, reddit, x, youtube) for the second research round, so the discovered launches/entities get chased into deeper searches. Every key falls back to the base query when missing.",
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

function createFormatReportDocumentTool(): AgentTool {
  return {
    kind: "full",
    definition: LAST30DAYS_FORMAT_REPORT_DOCUMENT_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const topic = args.topic;
      const reply = args.reply;
      if (typeof topic !== "string" || topic.trim().length === 0) {
        return { callId: call.id, isError: true, content: "topic is required" };
      }
      if (typeof reply !== "string" || reply.trim().length === 0) {
        return { callId: call.id, isError: true, content: "reply is required" };
      }
      return {
        callId: call.id,
        content: { title: topic.trim(), body: reply },
      };
    },
  };
}

function createCompetitorAnalysisFormatReportDocumentTool(): AgentTool {
  return {
    kind: "full",
    definition: COMPETITOR_ANALYSIS_FORMAT_REPORT_DOCUMENT_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const companyUrl = args.companyUrl;
      const reply = args.reply;
      if (typeof companyUrl !== "string" || companyUrl.trim().length === 0) {
        return {
          callId: call.id,
          isError: true,
          content: "companyUrl is required",
        };
      }
      if (typeof reply !== "string" || reply.trim().length === 0) {
        return { callId: call.id, isError: true, content: "reply is required" };
      }
      return {
        callId: call.id,
        content: { title: companyUrl.trim(), body: reply },
      };
    },
  };
}

function createFirecrawlUrlWatchFormatDocumentTool(): AgentTool {
  return {
    kind: "full",
    definition: FIRECRAWL_URL_WATCH_FORMAT_DOCUMENT_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const url = args.url;
      const reply = args.reply;
      if (typeof url !== "string" || url.trim().length === 0) {
        return { callId: call.id, isError: true, content: "url is required" };
      }
      if (typeof reply !== "string" || reply.trim().length === 0) {
        return { callId: call.id, isError: true, content: "reply is required" };
      }
      return {
        callId: call.id,
        content: { title: url.trim(), body: reply },
      };
    },
  };
}

function createSumbleAccountIntelFormatReportDocumentTool(): AgentTool {
  return {
    kind: "full",
    definition: SUMBLE_ACCOUNT_INTEL_FORMAT_REPORT_DOCUMENT_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const organizationDomain = args.organizationDomain;
      const reply = args.reply;
      if (
        typeof organizationDomain !== "string" ||
        organizationDomain.trim().length === 0
      ) {
        return {
          callId: call.id,
          isError: true,
          content: "organizationDomain is required",
        };
      }
      if (typeof reply !== "string" || reply.trim().length === 0) {
        return { callId: call.id, isError: true, content: "reply is required" };
      }
      return {
        callId: call.id,
        content: { title: organizationDomain.trim(), body: reply },
      };
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

// Every source step id the collect tool drains — round-1 fan-out plus the
// round-2 entity-chasing re-queries (web2/reddit2/x2/youtube2). A step id listed
// here but absent from the run simply contributes no items; the workflow is the
// source of truth for which actually run.
const SOURCE_STEP_IDS = [
  "hackernews",
  "github",
  "web",
  "webB",
  "webC",
  "reddit",
  "x",
  "youtube",
  "polymarket",
  "bluesky",
  "web2",
  "reddit2",
  "x2",
  "youtube2",
] as const;

// The second-round source keys the entity-extraction reply tailors. Only the
// engagement-rich, entity-chaseable platforms get a round 2 — HN/GitHub/Polymarket
// add little once the named launches are known.
export const ENTITY_ROUND_KEYS = ["web", "reddit", "x", "youtube"] as const;

// Relevance floor for the workflow brief: drop clusters the rerank/grounding
// scored below 40 (off-topic on the reference 0–100 scale) instead of padding
// topK with noise. A thin topic then yields an honestly-small brief. See
// buildReport's `minRelevance`.
const BRIEF_MIN_RELEVANCE = 40;

// Parse the entity-extraction LLM reply (tolerant of code fences / surrounding
// prose) into the round-2 per-source query map. Every ENTITY_ROUND_KEYS key is
// filled with the model's entity-focused query when non-empty, else the base
// query — so a malformed reply degrades to a duplicate round (deduped later)
// rather than blanking a round-2 source.
function parseEntityQueries(
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
          for (const key of ENTITY_ROUND_KEYS) {
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
  for (const key of ENTITY_ROUND_KEYS) {
    queries[key] = tailored.get(key) ?? baseQuery;
  }
  return queries;
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
  "webB",
  "webC",
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

// Returns object `content` (not a JSON string) so each source step can select
// its tailored query by field: `steps.groundQueries.output.content.<source>`.
// Nests each source's flat query string under a `query` key (CL-4232) so a
// downstream source step's plain `{ from: "steps.<ground|entity>Queries
// .output.content.<sourceKey>" }` selector yields `{ query: "..." }` — the
// tool's own argument name — directly, with no per-source argMap rename.
function nestQueryMap(
  flat: Record<string, string>,
): Record<string, { query: string }> {
  const nested: Record<string, { query: string }> = {};
  for (const [key, query] of Object.entries(flat)) {
    nested[key] = { query };
  }
  return nested;
}

function createGroundQueriesTool(): AgentTool {
  return {
    kind: "full",
    definition: LAST30DAYS_GROUND_QUERIES_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      // The block form emits `{ topic, focus }` verbatim (CL-2765); normalizeIntake
      // is the single place that derives `query = query || focus || topic`, so the
      // per-source fallback query still honors the human's focus rather than
      // collapsing to the bare topic.
      const baseQuery = readBaseQuery(
        args,
        "last30days_ground_queries requires a non-empty query or topic",
      );
      return {
        callId: call.id,
        content: nestQueryMap(parseGroundedQueries(args.reply, baseQuery)),
      };
    },
  };
}

interface CollectedItems {
  topic: string;
  days: number;
  items: (typeof ResearchItem.infer)[];
  skippedSources: SkippedSource[];
}

// Derive the per-source fallback query from a step's merged args (intake fields
// + the grounding/entity reply), routing through the ONE normalizeIntake
// derivation so `query = query || focus || topic` (CL-2765).
function readBaseQuery(
  args: Record<string, unknown>,
  emptyMessage: string,
): string {
  try {
    return normalizeIntake(args).query;
  } catch {
    throw new Error(emptyMessage);
  }
}

function readIntakeTopicDays(steps: Record<string, unknown>): {
  topic: string;
  days: number;
} {
  const intake =
    isRecord(steps.intake) && isRecord(steps.intake.output)
      ? steps.intake.output
      : {};
  const { topic, days } = normalizeIntake(intake);
  return { topic, days };
}

// Drain every source step (both rounds) into one clean candidate pool: parse the
// envelopes, validate items, then date-filter, dedupe, and structural-junk-filter
// so the curate LLM judges semantic quality (promo/shill/off-topic) on a compact,
// de-noised set rather than raw multi-source envelopes. The semantic judgment is
// the LLM's job (CL-2503); this only removes mechanical noise and the window.
function collectCleanItems(steps: Record<string, unknown>): CollectedItems {
  const { topic, days } = readIntakeTopicDays(steps);
  const rawItems: (typeof ResearchItem.infer)[] = [];
  const skippedSources: SkippedSource[] = [];
  for (const stepId of SOURCE_STEP_IDS) {
    if (steps[stepId] === undefined) continue;
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
  const nowIso = new Date().toISOString();
  const windowed = dateFilter(rawItems, { days, nowIso });
  const deduped = dedupe(windowed);
  const cleaned = qualityFilter(deduped);
  return { topic, days, items: cleaned, skippedSources };
}

// Returns object `content` so the curate step reads a single compact pool
// (`steps.collect.output.content.items`) instead of N raw source envelopes.
function createCollectTool(): AgentTool {
  return {
    kind: "full",
    definition: LAST30DAYS_COLLECT_DEFINITION,
    handler: async (call) => {
      const steps = coerceArgsObject(call.arguments);
      const { topic, days, items, skippedSources } = collectCleanItems(steps);
      // A `full` tool's content is `Record<string, unknown>`; build the pool as a
      // plain record so each field is addressable downstream
      // (`steps.collect.output.content.items`).
      const content: Record<string, unknown> = {
        topic,
        days,
        items,
        skippedSources,
      };
      return { callId: call.id, content };
    },
  };
}

function createEntityQueriesTool(): AgentTool {
  return {
    kind: "full",
    definition: LAST30DAYS_ENTITY_QUERIES_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const baseQuery = readBaseQuery(
        args,
        "last30days_entity_queries requires a non-empty query or topic",
      );
      return {
        callId: call.id,
        content: nestQueryMap(parseEntityQueries(args.reply, baseQuery)),
      };
    },
  };
}

function readCollected(steps: Record<string, unknown>): CollectedItems {
  const output =
    isRecord(steps.collect) && isRecord(steps.collect.output)
      ? steps.collect.output
      : undefined;
  const content = isRecord(output) ? output.content : undefined;
  if (!isRecord(content)) {
    // No collect output reachable — drain the source steps directly so the brief
    // never silently empties when the selector shape shifts.
    return collectCleanItems(steps);
  }
  const { topic, days } = readIntakeTopicDays(steps);
  const { items } = collectValidItems(
    Array.isArray(content.items) ? content.items : [],
  );
  const skippedSources: SkippedSource[] = [];
  if (Array.isArray(content.skippedSources)) {
    for (const entry of content.skippedSources) {
      const validated = SkippedSource(entry);
      if (!(validated instanceof type.errors)) skippedSources.push(validated);
    }
  }
  return { topic, days, items, skippedSources };
}

// The LLM curate reply (CL-2503): a JSON object of named themes + verbatim
// quotes. Parse it tolerantly (code fences / surrounding prose); a missing or
// malformed reply yields null and the brief falls back to the deterministic
// buildReport pipeline.
function parseCurateReply(step: unknown): unknown {
  const output = isRecord(step) ? step.output : undefined;
  const reply = isRecord(output) ? output.reply : undefined;
  if (typeof reply !== "string") return undefined;
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function createWorkflowBriefTool(): AgentTool {
  return {
    kind: "string",
    definition: LAST30DAYS_WORKFLOW_BRIEF_DEFINITION,
    handler: async (args) => {
      const steps = coerceArgsObject(args);
      const { topic, days, items, skippedSources } = readCollected(steps);
      const nowIso = new Date().toISOString();

      const curation = coerceCuration(parseCurateReply(steps.curate));
      if (curation !== null) {
        const curated = buildReportFromCuration(items, curation, {
          topic,
          days,
          nowIso,
          skippedSources,
        });
        if (curated !== null) return JSON.stringify(curated);
      }

      // Fallback: curate returned junk or no usable theme — assemble the brief
      // deterministically so the writer still gets a structured input.
      return JSON.stringify(
        buildReport(items, {
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

function createHeartbeatFormatBriefNotifyTool(): AgentTool {
  return {
    kind: "full",
    definition: HEARTBEAT_FORMAT_BRIEF_NOTIFY_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const userAddress = args.userAddress;
      const title = args.title;
      const body = args.body;
      const artifactId = args.artifactId;
      const runId = args.runId;
      const workflowLabel =
        typeof args.workflowLabel === "string" ? args.workflowLabel : undefined;
      for (const [name, value] of [
        ["userAddress", userAddress],
        ["title", title],
        ["body", body],
        ["artifactId", artifactId],
        ["runId", runId],
      ] as const) {
        if (typeof value !== "string" || value.trim().length === 0) {
          return {
            callId: call.id,
            isError: true,
            content: `${name} is required`,
          };
        }
      }
      try {
        const content = morningBriefNotifyMail({
          userAddress: userAddress as string,
          title: title as string,
          body: body as string,
          artifactId: artifactId as string,
          runId: runId as string,
          ...(workflowLabel !== undefined ? { workflowLabel } : {}),
        });
        return { callId: call.id, content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { callId: call.id, isError: true, content: message };
      }
    },
  };
}

function createHeartbeatFormatBriefDocumentTool(): AgentTool {
  return {
    kind: "full",
    definition: HEARTBEAT_FORMAT_BRIEF_DOCUMENT_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const title = args.title;
      const reply = args.reply;
      if (typeof title !== "string" || title.trim().length === 0) {
        return { callId: call.id, isError: true, content: "title is required" };
      }
      if (typeof reply !== "string" || reply.trim().length === 0) {
        return { callId: call.id, isError: true, content: "reply is required" };
      }
      try {
        const content = formatHeartbeatBriefDocument(title, reply);
        return { callId: call.id, content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { callId: call.id, isError: true, content: message };
      }
    },
  };
}

function createHeartbeatFormatBriefTitleTool(): AgentTool {
  return {
    kind: "full",
    definition: HEARTBEAT_FORMAT_BRIEF_TITLE_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const userDisplayName =
        typeof args.userDisplayName === "string"
          ? args.userDisplayName
          : undefined;
      const title = formatHeartbeatBriefTitle(userDisplayName, Date.now());
      return { callId: call.id, content: { title } };
    },
  };
}

function createHeartbeatMergeBriefSourcesTool(): AgentTool {
  return {
    kind: "full",
    definition: HEARTBEAT_MERGE_BRIEF_SOURCES_DEFINITION,
    handler: async (call) => {
      const steps = coerceArgsObject(call.arguments);
      const content = mergeHeartbeatBriefSources(steps);
      return { callId: call.id, content };
    },
  };
}

/** The stateless last30days core tools (no credential, no host context). */
export function createLast30daysTools(): AgentTool[] {
  return [
    createExtractTool(),
    createReportTool(),
    createFormatReportDocumentTool(),
    createGroundQueriesTool(),
    createEntityQueriesTool(),
    createCollectTool(),
    createWorkflowBriefTool(),
    createValidateTool(),
    createHeartbeatMergeBriefSourcesTool(),
    createHeartbeatFormatBriefTitleTool(),
    createHeartbeatFormatBriefDocumentTool(),
    createHeartbeatFormatBriefNotifyTool(),
    createCompetitorAnalysisFormatReportDocumentTool(),
    createSumbleAccountIntelFormatReportDocumentTool(),
    createFirecrawlUrlWatchFormatDocumentTool(),
  ];
}
