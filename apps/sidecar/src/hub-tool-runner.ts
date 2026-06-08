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
/** Extract an `error` message from a JSON error body, or null if it is not JSON. */
function parseError(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: string };
    return parsed.error ?? null;
  } catch {
    return null;
  }
}

export function createHubToolRunner({
  hubHttpUrl,
  sidecarToken,
  tenantId,
  toolDefinitions,
}: HubToolRunnerOpts): ToolRunner & { definitions: ToolDefinition[] } {
  return {
    definitions: toolDefinitions,

    async run(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      let response: Response;
      let body: string;

      try {
        response = await fetch(`${hubHttpUrl}/api/internal/tools/run`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sidecarToken}`,
          },
          body: JSON.stringify({ tenantId, toolName: call.name, args: call.arguments }),
          signal,
        });
        body = await response.text();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { callId: call.id, content: message, isError: true };
      }

      // Read status before parsing: an infra error (e.g. a 404 with an HTML or
      // empty body) must surface the real status, not a misleading JSON parse error.
      if (!response.ok) {
        const detail = parseError(body) ?? body.trim();
        const content = detail
          ? `Tool execution failed (${response.status}): ${detail}`
          : `Tool execution failed (${response.status})`;
        return { callId: call.id, content, isError: true };
      }

      let data: { result: string; isError: boolean };
      try {
        data = JSON.parse(body) as { result: string; isError: boolean };
      } catch {
        return {
          callId: call.id,
          content: `Tool returned an unparseable response: ${body.slice(0, 200)}`,
          isError: true,
        };
      }

      return { callId: call.id, content: data.result, isError: data.isError };
    },
  };
}
