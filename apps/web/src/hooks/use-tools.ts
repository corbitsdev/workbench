import { useQuery } from '@tanstack/react-query';
import { type } from 'arktype';
import { api } from '../lib/api';

const toolSummarySchema = type({
  name: 'string',
  providerName: 'string',
  description: 'string',
});

const toolsResponseSchema = type({ tools: toolSummarySchema.array() });

export type ToolSummary = typeof toolSummarySchema.infer;

const toolDetailSchema = type({
  name: 'string',
  providerName: 'string',
  description: 'string',
  inputSchema: 'unknown',
});

const toolDetailResponseSchema = type({ tool: toolDetailSchema });

export type ToolDetail = typeof toolDetailSchema.infer;

export function useToolsLibrary(tenantId?: string | null) {
  return useQuery<ToolSummary[]>({
    queryKey: ['tools', tenantId ?? null],
    queryFn: async () => {
      const raw = await api<unknown>(
        'GET',
        `/tools${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ''}`
      );
      const parsed = toolsResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected tools response: ${parsed.summary}`);
      }
      return parsed.tools;
    },
    staleTime: 5 * 60_000,
  });
}

export function useToolDetail(name: string | null, tenantId?: string | null) {
  return useQuery<ToolDetail>({
    queryKey: ['tool', name, tenantId ?? null],
    queryFn: async () => {
      if (!name) throw new Error('Tool name is required');
      const raw = await api<unknown>(
        'GET',
        `/tools/${encodeURIComponent(name)}${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ''}`
      );
      const parsed = toolDetailResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected tool response: ${parsed.summary}`);
      }
      return parsed.tool;
    },
    enabled: Boolean(name),
    staleTime: 5 * 60_000,
  });
}
