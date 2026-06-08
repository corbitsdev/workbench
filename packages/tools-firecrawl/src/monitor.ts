import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';
import {
  firecrawlFetchJSON,
  optionalRecord,
  requiredString,
  resolveConfig,
  stringTool,
  type FirecrawlToolsConfig,
  type ResolvedFirecrawlConfig,
} from './shared';

async function createMonitor(
  config: ResolvedFirecrawlConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  const monitorConfig = optionalRecord(args.config);
  if (monitorConfig === null) {
    throw new Error('config is required');
  }

  return firecrawlFetchJSON(
    config,
    { method: 'POST', path: '/monitor', body: monitorConfig },
    signal
  );
}

async function getMonitor(
  config: ResolvedFirecrawlConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  const id = requiredString(args, 'id');
  return firecrawlFetchJSON(
    config,
    { method: 'GET', path: `/monitor/${encodeURIComponent(id)}` },
    signal
  );
}

async function updateMonitor(
  config: ResolvedFirecrawlConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  const id = requiredString(args, 'id');
  const monitorConfig = optionalRecord(args.config);
  if (monitorConfig === null) {
    throw new Error('config is required');
  }

  return firecrawlFetchJSON(
    config,
    { method: 'PATCH', path: `/monitor/${encodeURIComponent(id)}`, body: monitorConfig },
    signal
  );
}

async function deleteMonitor(
  config: ResolvedFirecrawlConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  const id = requiredString(args, 'id');
  return firecrawlFetchJSON(
    config,
    { method: 'DELETE', path: `/monitor/${encodeURIComponent(id)}` },
    signal
  );
}

async function listMonitors(
  config: ResolvedFirecrawlConfig,
  _args: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  return firecrawlFetchJSON(config, { method: 'GET', path: '/monitor' }, signal);
}

async function runMonitor(
  config: ResolvedFirecrawlConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  const id = requiredString(args, 'id');
  return firecrawlFetchJSON(
    config,
    { method: 'POST', path: `/monitor/${encodeURIComponent(id)}/run` },
    signal
  );
}

async function listMonitorChecks(
  config: ResolvedFirecrawlConfig,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<unknown> {
  const id = requiredString(args, 'id');
  return firecrawlFetchJSON(
    config,
    { method: 'GET', path: `/monitor/${encodeURIComponent(id)}/checks` },
    signal
  );
}

export const FIRECRAWL_MONITOR_CREATE_DEFINITION: ToolDefinition = {
  name: 'firecrawl_monitor_create',
  description:
    'Create a Firecrawl monitor to schedule recurring scrapes or crawls with change detection.',
  inputSchema: {
    type: 'object',
    properties: {
      config: {
        type: 'object',
        description: 'Monitor configuration: name, schedule, targets, webhook, notification, etc.',
      },
    },
    required: ['config'],
  },
};

export const FIRECRAWL_MONITOR_GET_DEFINITION: ToolDefinition = {
  name: 'firecrawl_monitor_get',
  description: 'Get a Firecrawl monitor by id.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Monitor id to retrieve.',
      },
    },
    required: ['id'],
  },
};

export const FIRECRAWL_MONITOR_UPDATE_DEFINITION: ToolDefinition = {
  name: 'firecrawl_monitor_update',
  description: 'Update a Firecrawl monitor by id.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Monitor id to update.',
      },
      config: {
        type: 'object',
        description: 'Partial monitor configuration to update.',
      },
    },
    required: ['id', 'config'],
  },
};

export const FIRECRAWL_MONITOR_DELETE_DEFINITION: ToolDefinition = {
  name: 'firecrawl_monitor_delete',
  description: 'Delete a Firecrawl monitor by id.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Monitor id to delete.',
      },
    },
    required: ['id'],
  },
};

export const FIRECRAWL_MONITOR_LIST_DEFINITION: ToolDefinition = {
  name: 'firecrawl_monitor_list',
  description: 'List all Firecrawl monitors.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export const FIRECRAWL_MONITOR_RUN_DEFINITION: ToolDefinition = {
  name: 'firecrawl_monitor_run',
  description: 'Trigger a Firecrawl monitor check immediately.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Monitor id to run.',
      },
    },
    required: ['id'],
  },
};

export const FIRECRAWL_MONITOR_CHECK_DEFINITION: ToolDefinition = {
  name: 'firecrawl_monitor_check',
  description: 'List check results for a Firecrawl monitor.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Monitor id to list checks for.',
      },
    },
    required: ['id'],
  },
};

export const MONITOR_DEFINITIONS: ToolDefinition[] = [
  FIRECRAWL_MONITOR_CREATE_DEFINITION,
  FIRECRAWL_MONITOR_GET_DEFINITION,
  FIRECRAWL_MONITOR_UPDATE_DEFINITION,
  FIRECRAWL_MONITOR_DELETE_DEFINITION,
  FIRECRAWL_MONITOR_LIST_DEFINITION,
  FIRECRAWL_MONITOR_RUN_DEFINITION,
  FIRECRAWL_MONITOR_CHECK_DEFINITION,
];

export function createMonitorTools(config: FirecrawlToolsConfig): AgentTool[] {
  const resolved = resolveConfig(config);

  return [
    stringTool(FIRECRAWL_MONITOR_CREATE_DEFINITION, (args, signal) =>
      createMonitor(resolved, args, signal)
    ),
    stringTool(FIRECRAWL_MONITOR_GET_DEFINITION, (args, signal) =>
      getMonitor(resolved, args, signal)
    ),
    stringTool(FIRECRAWL_MONITOR_UPDATE_DEFINITION, (args, signal) =>
      updateMonitor(resolved, args, signal)
    ),
    stringTool(FIRECRAWL_MONITOR_DELETE_DEFINITION, (args, signal) =>
      deleteMonitor(resolved, args, signal)
    ),
    stringTool(FIRECRAWL_MONITOR_LIST_DEFINITION, (_args, signal) =>
      listMonitors(resolved, _args, signal)
    ),
    stringTool(FIRECRAWL_MONITOR_RUN_DEFINITION, (args, signal) =>
      runMonitor(resolved, args, signal)
    ),
    stringTool(FIRECRAWL_MONITOR_CHECK_DEFINITION, (args, signal) =>
      listMonitorChecks(resolved, args, signal)
    ),
  ];
}
