import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';
import { type } from 'arktype';
import { buildReport, entityExtract, ResearchItem } from '@workbench/last30days-core';

export const LAST30DAYS_CORE_EXTRACT_DEFINITION: ToolDefinition = {
  name: 'last30days_core_extract',
  description:
    'Extract entities (handles, repos, subreddits, hashtags, keywords) from a topic string.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Topic string to extract entities from.' },
    },
    required: ['topic'],
  },
};

export const LAST30DAYS_CORE_REPORT_DEFINITION: ToolDefinition = {
  name: 'last30days_core_report',
  description:
    'Build a structured research brief from raw ResearchItems. Applies date filter, dedupe, cluster-merge, and rank scoring, and returns ranked clusters, stats, a lead headline, best-takes, items, and citations. Pass the returned object verbatim as write_artifact { data } for rich rendering.',
  inputSchema: {
    type: 'object',
    properties: {
      rawItems: {
        type: 'array',
        items: { type: 'object' },
        description: 'Array of ResearchItem objects to process.',
      },
      topic: { type: 'string', description: 'Topic label for the report.' },
      days: {
        type: 'number',
        description: 'Number of days to include in the date window. Defaults to 30.',
      },
      topK: {
        type: 'number',
        description: 'Maximum number of top items to include. Defaults to 20.',
      },
    },
    required: ['rawItems', 'topic'],
  },
};

export const LAST30DAYS_VALIDATE_DEFINITION: ToolDefinition = {
  name: 'last30days_validate',
  description: 'Validate a report body against its citations. (Stub — full validation is CL-1569.)',
  inputSchema: {
    type: 'object',
    properties: {
      body: { type: 'string', description: 'Report body to validate.' },
      citations: {
        type: 'array',
        items: { type: 'object' },
        description: 'Citations to check against.',
      },
      returnedItemUrls: {
        type: 'array',
        items: { type: 'string' },
        description: 'URLs of items returned from research.',
      },
    },
    required: ['body', 'citations', 'returnedItemUrls'],
  },
};

function coerceArgsObject(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args._raw === 'string') {
    const parsed: unknown = JSON.parse(args._raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('_raw fallback is not a JSON object');
    }
    return parsed as Record<string, unknown>;
  }
  return args;
}

function createExtractTool(): AgentTool {
  return {
    kind: 'string',
    definition: LAST30DAYS_CORE_EXTRACT_DEFINITION,
    handler: async (args) => {
      const effective = coerceArgsObject(args);
      const topic = effective.topic;
      if (typeof topic !== 'string' || topic.trim().length === 0) {
        throw new Error('topic is required');
      }
      return JSON.stringify(entityExtract(topic));
    },
  };
}

function createReportTool(): AgentTool {
  return {
    kind: 'string',
    definition: LAST30DAYS_CORE_REPORT_DEFINITION,
    handler: async (args) => {
      const effective = coerceArgsObject(args);
      const topic = effective.topic;
      if (typeof topic !== 'string' || topic.trim().length === 0) {
        throw new Error('topic is required');
      }
      let rawItemsInput: unknown = effective.rawItems;
      if (typeof rawItemsInput === 'string') {
        const parsed: unknown = JSON.parse(rawItemsInput);
        if (!Array.isArray(parsed)) {
          throw new Error('rawItems stringified value is not an array');
        }
        rawItemsInput = parsed;
      }
      if (!Array.isArray(rawItemsInput)) {
        throw new Error('rawItems must be an array');
      }
      const rawItems = rawItemsInput.map((item: unknown, i: number) => {
        const validated = ResearchItem(item);
        if (validated instanceof type.errors) {
          throw new Error(`rawItems[${i}] is invalid: ${String(validated)}`);
        }
        return validated;
      });
      const days = typeof effective.days === 'number' ? effective.days : 30;
      const topK = typeof effective.topK === 'number' ? effective.topK : 20;
      const nowIso = new Date().toISOString();
      return JSON.stringify(buildReport(rawItems, { topic, days, topK, nowIso }));
    },
  };
}

function createValidateTool(): AgentTool {
  return {
    kind: 'string',
    definition: LAST30DAYS_VALIDATE_DEFINITION,
    handler: async (args) => {
      const body = args.body;
      if (typeof body !== 'string') {
        throw new Error('body is required');
      }
      return JSON.stringify({ ok: true, body });
    },
  };
}

/** The stateless last30days core tools (no credential, no host context). */
export function createLast30daysTools(): AgentTool[] {
  return [createExtractTool(), createReportTool(), createValidateTool()];
}
