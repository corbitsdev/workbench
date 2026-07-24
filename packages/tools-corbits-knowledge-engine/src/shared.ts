/**
 * Shared primitives for the Corbits Knowledge Engine tool package.
 *
 * `search.ts` and `capture.ts` both import from here: the config type, a
 * generic HTTP helper for the engine's two endpoints, and argument/response
 * parsing utilities. Mirrors `packages/tools-firecrawl/src/shared.ts`.
 */
import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

export type KnowledgeEngineFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/**
 * The engine has no well-known public base URL (it is a tenant's own
 * deployment), so unlike Firecrawl's `FIRECRAWL_DEFAULT_BASE_URL` there is no
 * package-owned default — the credential's `baseURL` (the provider's
 * `metadata.baseURL`) is always required.
 */
export const KnowledgeEngineToolsConfigSchema = type({
  apiKey: "string",
  baseURL: "string",
  tenantId: "string",
  "principalId?": "string | null",
});

export type KnowledgeEngineToolsConfig =
  typeof KnowledgeEngineToolsConfigSchema.infer & {
    fetcher?: KnowledgeEngineFetch;
  };

export type ResolvedKnowledgeEngineConfig = KnowledgeEngineToolsConfig;

/**
 * Validate a caller-supplied config. `tenantId` (and, when present,
 * `principalId`) are resolved by the caller from the tool-execution context
 * (the sidecar's hub-RPC context) — never from agent-supplied tool
 * arguments, so a caller cannot spoof another tenant's knowledge base.
 */
export function resolveConfig(
  config: KnowledgeEngineToolsConfig,
): ResolvedKnowledgeEngineConfig {
  validateConfig(config);
  return config;
}

function validateConfig(config: KnowledgeEngineToolsConfig): void {
  if (config.apiKey.length === 0) {
    throw new Error("Knowledge engine service token is required");
  }
  if (config.baseURL.trim().length === 0) {
    throw new Error("Knowledge engine baseURL is required");
  }
  try {
    new URL(config.baseURL);
  } catch {
    throw new Error("Knowledge engine baseURL must be a valid URL");
  }
  if (typeof config.tenantId !== "string" || config.tenantId.length === 0) {
    throw new Error(
      "Knowledge engine tenantId is required — this tool must run inside an agent session, not as a standalone one-off call",
    );
  }
}

function knowledgeEngineHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/** Pretty-printed JSON, the standard string-tool result shape in this repo. */
export function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Build an AgentTool whose handler returns the JSON-stringified call result. */
export function stringTool(
  definition: ToolDefinition,
  call: (
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>,
): AgentTool {
  return {
    kind: "string",
    definition,
    handler: async (args, signal) => jsonResult(await call(args, signal)),
  };
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

export type KnowledgeEngineRequest = {
  /** Path appended to the base URL, beginning with `/` (e.g. `/api/search`). */
  path: string;
  /** JSON request body. */
  body: unknown;
};

/**
 * Single HTTP entry point for both engine endpoints. Sets the bearer auth
 * header and surfaces non-2xx responses as a `Knowledge engine API error:
 * <status> <detail>` throw. Returns the parsed JSON body as `unknown`.
 */
export async function knowledgeEngineFetchJSON(
  config: ResolvedKnowledgeEngineConfig,
  request: KnowledgeEngineRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const url = `${normalizeBaseUrl(config.baseURL)}${request.path}`;
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url, {
    method: "POST",
    headers: knowledgeEngineHeaders(config.apiKey),
    body: JSON.stringify(request.body),
    signal,
  } satisfies RequestInit);

  if (!response.ok) {
    const body = errorMessageFromBody(await response.text().catch(() => ""));
    const detail = body ?? response.statusText;
    throw new Error(
      `Knowledge engine API error: ${response.status} ${detail ?? ""}`,
    );
  }

  return (await response.json()) as unknown;
}

export function errorMessageFromBody(text: string): string | null {
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      if (typeof parsed.error === "string") {
        return parsed.error;
      }
      if (typeof parsed.message === "string") {
        return parsed.message;
      }
    }
  } catch {
    return text;
  }
  return text;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate tool args at the trust boundary using an arktype schema. */
export function parseArgs<T>(
  schema: (input: unknown) => T | type.errors,
  args: unknown,
  toolName: string,
): T {
  const parsed = schema(args);
  if (parsed instanceof type.errors) {
    throw new Error(`${toolName}: ${parsed.summary}`);
  }
  return parsed;
}
