import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";
import {
  buildReport,
  entityExtract,
  ResearchItem,
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

function parseJsonString(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${label} is not valid JSON: ${reason}`);
  }
}

function readToolContent(output: unknown, label: string): unknown {
  if (!isRecord(output)) return [];
  const content = output.content;
  if (typeof content !== "string" || content.trim().length === 0) return [];
  return parseJsonString(content, label);
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
  "bluesky",
] as const;

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
      const rawInputs: unknown[] = [];
      for (const stepId of SOURCE_STEP_IDS) {
        const step = steps[stepId];
        const output = isRecord(step) ? step.output : undefined;
        const parsed = readToolContent(output, `${stepId}.output.content`);
        rawInputs.push(...collectItems(parsed));
      }
      const rawItems = readRawItems(rawInputs);
      const nowIso = new Date().toISOString();
      return JSON.stringify(
        buildReport(rawItems, { topic, days, topK: 20, nowIso }),
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
    createWorkflowBriefTool(),
    createValidateTool(),
  ];
}
