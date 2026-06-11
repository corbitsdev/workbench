import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';
import { type } from 'arktype';
import { buildReport, entityExtract, ResearchItem } from '@workbench/last30days-core';
import type { ContextToolEntry } from '../lib/tool-registry';

const LAST30DAYS_CORE_EXTRACT_DEFINITION: ToolDefinition = {
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

const LAST30DAYS_CORE_REPORT_DEFINITION: ToolDefinition = {
  name: 'last30days_core_report',
  description:
    'Build a ranked research report from raw ResearchItems. Applies date filter, dedupe, cluster-merge, and rank scoring.',
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

const LAST30DAYS_VALIDATE_DEFINITION: ToolDefinition = {
  name: 'last30days_validate',
  description:
    'Validate a report body against its citations. (Stub — full validation is CL-1569.)',
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

function createLast30daysCoreExtractTool(): AgentTool {
  return {
    kind: 'string',
    definition: LAST30DAYS_CORE_EXTRACT_DEFINITION,
    handler: async (args, _signal) => {
      const topic = args.topic;
      if (typeof topic !== 'string' || topic.trim().length === 0) {
        throw new Error('topic is required');
      }
      const result = entityExtract(topic);
      return JSON.stringify(result);
    },
  };
}

function createLast30daysCoreReportTool(): AgentTool {
  return {
    kind: 'string',
    definition: LAST30DAYS_CORE_REPORT_DEFINITION,
    handler: async (args, _signal) => {
      const topic = args.topic;
      if (typeof topic !== 'string' || topic.trim().length === 0) {
        throw new Error('topic is required');
      }
      if (!Array.isArray(args.rawItems)) {
        throw new Error('rawItems must be an array');
      }
      const rawItems = args.rawItems.map((item: unknown, i: number) => {
        const validated = ResearchItem(item);
        if (validated instanceof type.errors) {
          throw new Error(`rawItems[${i}] is invalid: ${String(validated)}`);
        }
        return validated;
      });
      const days = typeof args.days === 'number' ? args.days : 30;
      const topK = typeof args.topK === 'number' ? args.topK : 20;
      const nowIso = new Date().toISOString();
      const report = buildReport(rawItems, { topic, days, topK, nowIso });
      return JSON.stringify(report);
    },
  };
}

function createLast30daysValidateTool(): AgentTool {
  return {
    kind: 'string',
    definition: LAST30DAYS_VALIDATE_DEFINITION,
    handler: async (args, _signal) => {
      const body = args.body;
      if (typeof body !== 'string') {
        throw new Error('body is required');
      }
      return JSON.stringify({ ok: true, body });
    },
  };
}

export const LAST30DAYS_CORE_HUB_TOOLS: Record<string, ContextToolEntry> = {
  last30days_core_extract: {
    definition: LAST30DAYS_CORE_EXTRACT_DEFINITION,
    createTools: (_context) => [createLast30daysCoreExtractTool()],
  },
  last30days_core_report: {
    definition: LAST30DAYS_CORE_REPORT_DEFINITION,
    createTools: (_context) => [createLast30daysCoreReportTool()],
  },
  last30days_validate: {
    definition: LAST30DAYS_VALIDATE_DEFINITION,
    createTools: (_context) => [createLast30daysValidateTool()],
  },
};
