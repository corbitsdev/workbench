import type { ToolCall, ToolDefinition, ToolResult, ToolRunner } from '@intx/types/runtime';

type HubToolRunnerOpts = {
  hubHttpUrl: string;
  sidecarToken: string;
  tenantId: string;
  toolDefinitions: ToolDefinition[];
};

/**
 * Generic tool runner that proxies all execution to the hub's internal tools
 * endpoint. The hub resolves the tenant credential and runs the tool — the
 * sidecar needs no tool-specific code.
 *
 * To add a new hub-managed tool, register it in apps/hub/src/lib/tool-registry.ts.
 * No sidecar changes required.
 */
export function createHubToolRunner({
  hubHttpUrl,
  sidecarToken,
  tenantId,
  toolDefinitions,
}: HubToolRunnerOpts): ToolRunner & { definitions: ToolDefinition[] } {
  return {
    definitions: toolDefinitions,

    async run(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      let data: { result: string; isError: boolean };

      try {
        const response = await fetch(`${hubHttpUrl}/api/internal/tools/run`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sidecarToken}`,
          },
          body: JSON.stringify({ tenantId, toolName: call.name, args: call.arguments }),
          signal,
        });

        data = (await response.json()) as { result: string; isError: boolean };

        if (!response.ok) {
          return {
            callId: call.id,
            content: (data as unknown as { error?: string }).error ?? 'Tool execution failed',
            isError: true,
          };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { callId: call.id, content: message, isError: true };
      }

      return { callId: call.id, content: data.result, isError: data.isError };
    },
  };
}
