// `interchange.tools` factory builder for credentialed tool packages.
// Imports @intx/agent, so it lives on a separate entry from the wire
// schemas — the hub/sidecar import only the schemas (no agent runtime).

import {
  type AgentTool,
  type AnnotatedToolFactory,
  createToolRunner,
  defineTool,
} from "@intx/agent";
import type { ToolDefinition, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";
import {
  HUB_RPC_ENV_KEY,
  type ToolCredential,
  getHubRpc,
  getToolCredential,
  toolCredentialEnvKey,
} from "./index";

const HubToolRunResponse = type({ result: "string", isError: "boolean" });

/** Whether a tool only reads external state (`read`) or mutates it (`write`). */
export type ToolSideEffect = "read" | "write";

/** A `*_HUB_TOOLS`-style entry whose tools are built from a credential. */
export type CredentialedToolEntry = {
  /**
   * Whether this tool mutates external or durable state. Technical
   * classification only — forced human approval is a separate product set
   * (`APPROVAL_REQUIRED_BARE_NAMES` in `@workbench/agents`), a subset of
   * write tools.
   */
  sideEffect: ToolSideEffect;
  createTools: (config: ToolCredential) => AgentTool[];
};

/** Bare names of entries classified as `write` (for gate / audit tests). */
export function writeToolNamesFromEntries(
  entries: Record<string, { sideEffect: ToolSideEffect }>,
): string[] {
  return Object.entries(entries)
    .filter(([, entry]) => entry.sideEffect === "write")
    .map(([name]) => name)
    .sort();
}

/**
 * Build the factory for a credentialed tool package: declares the
 * provider credential as a `requires` env key, reads it at construction,
 * and builds every tool the package exposes (deduped by name, since some
 * `*_HUB_TOOLS` entries each return the full set).
 */
export function defineCredentialedToolPackage(opts: {
  id: string;
  provider: string;
  entries: Record<string, CredentialedToolEntry>;
}): AnnotatedToolFactory {
  return defineTool({
    id: opts.id,
    requires: [toolCredentialEnvKey(opts.provider)],
    factory: (env) => {
      const credential = getToolCredential(
        env as unknown as Record<string, unknown>,
        opts.provider,
      );
      const byName = new Map<string, AgentTool>();
      for (const entry of Object.values(opts.entries)) {
        for (const tool of entry.createTools(credential)) {
          if (!byName.has(tool.definition.name))
            byName.set(tool.definition.name, tool);
        }
      }
      return createToolRunner([...byName.values()]);
    },
  });
}

/**
 * Build the factory for a hub-backed tool package. The tools' definitions
 * live in the package; execution happens hub-side. The factory declares
 * the hub-RPC context as a `requires` env key and forwards every call to
 * the hub's scoped `/api/internal/hub-tools/run` endpoint, which authorizes
 * against the instance principal's grants. No tool secrets in the sidecar.
 */
export function defineHubBackedToolPackage(opts: {
  id: string;
  definitions: readonly ToolDefinition[];
}): AnnotatedToolFactory {
  return defineTool({
    id: opts.id,
    requires: [HUB_RPC_ENV_KEY],
    factory: (env) => {
      const ctx = getHubRpc(env as unknown as Record<string, unknown>);
      return {
        definitions: opts.definitions,
        async run(call, signal): Promise<ToolResult> {
          try {
            const res = await fetch(
              `${ctx.baseURL}/api/internal/hub-tools/run`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${ctx.token}`,
                },
                body: JSON.stringify({
                  tenantId: ctx.tenantId,
                  agentId: ctx.agentId,
                  principalId: ctx.principalId,
                  sessionId: ctx.sessionId,
                  toolName: call.name,
                  args: call.arguments,
                }),
                signal,
              },
            );
            if (!res.ok) {
              const text = await res.text();
              return {
                callId: call.id,
                content: `hub tool ${call.name} failed: ${String(res.status)} ${text}`,
                isError: true,
              };
            }
            const parsed = HubToolRunResponse(await res.json());
            if (parsed instanceof type.errors) {
              return {
                callId: call.id,
                content: `invalid hub-tool response: ${parsed.summary}`,
                isError: true,
              };
            }
            return {
              callId: call.id,
              content: parsed.result,
              isError: parsed.isError,
            };
          } catch (err) {
            return {
              callId: call.id,
              content: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        },
      };
    },
  });
}
