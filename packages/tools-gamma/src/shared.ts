import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

export type GammaFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

// https://developers.gamma.app — base URL verified against live API docs
export const GAMMA_DEFAULT_BASE_URL = "https://public-api.gamma.app/v1.0";

// fetcher is a runtime-injection concern (a function); it cannot be validated
// by arktype at parse time and is not present in serialised config.
const GammaToolsConfigSchema = type({
  apiKey: "string",
  "baseUrl?": "string",
});

export type GammaToolsConfig = {
  apiKey: string;
  baseUrl?: string;
  fetcher?: GammaFetch;
};

export type ResolvedGammaConfig = {
  apiKey: string;
  baseUrl: string;
  fetcher?: GammaFetch;
};

// Generated decks are created under the API key's identity. Without explicit
// sharing they default to private-to-that-identity and never surface for the
// workspace members who own the key — so every generation is shared with the
// whole workspace, and view-only via its link (externalAccess "view" is
// link-gated, not public/indexed, per the Gamma generations API).
export const WORKSPACE_SHARING_OPTIONS = {
  workspaceAccess: "fullAccess",
  externalAccess: "view",
} as const;

// Automatic export after generation. Gamma accepts "pdf" | "pptx" | "png"; we
// pull the PDF so the deck can be ingested durably into Workbench artifacts
// (the returned exportUrl is a temporary download link — see README).
export const GENERATION_EXPORT_FORMAT = "pdf" as const;

const GenerationResultSchema = type({
  gammaUrl: "string",
  gammaId: "string",
  "exportUrl?": "string",
});

export type GenerationResult = typeof GenerationResultSchema.infer;

// The deck-generation tools' output shape. `url` mirrors `gammaUrl` and
// `exportUrl` is always present (empty when Gamma returns no export link) so a
// downstream argMap keyed on any of these fields resolves without a fallback.
export const GammaDeckResultSchema = type({
  gammaUrl: "string",
  url: "string",
  gammaId: "string",
  exportUrl: "string",
});

export type GammaDeckResult = typeof GammaDeckResultSchema.infer;

// Gamma has returned the completed deck's URL under `gammaUrl` (current shape)
// and, on some responses / older API surfaces, under `url`. Consumers keyed on
// `gammaUrl` (e.g. the presentation workflow's persist argMap) throw on a bare
// `url`, so normalize a `url`-only response up to `gammaUrl` before parsing.
function normalizeDeckUrlKey(result: Record<string, unknown>): unknown {
  if (typeof result["gammaUrl"] === "string") return result;
  if (typeof result["url"] === "string") {
    return { ...result, gammaUrl: result["url"] };
  }
  return result;
}

export const GenerationStatusSchema = type(
  "'pending' | 'completed' | 'failed'",
);
export type GenerationStatus = typeof GenerationStatusSchema.infer;

export const HttpMethodSchema = type(
  "'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'",
);
export type HttpMethod = typeof HttpMethodSchema.infer;

export type GammaRequest = {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined> | undefined;
  body?: unknown;
};

export function parseGammaToolsConfig(raw: unknown): GammaToolsConfig {
  const parsed = GammaToolsConfigSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid Gamma config: ${parsed.summary}`);
  }
  return parsed as GammaToolsConfig;
}

export function resolveConfig(config: GammaToolsConfig): ResolvedGammaConfig {
  const resolved: ResolvedGammaConfig = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl?.trim() || GAMMA_DEFAULT_BASE_URL,
    ...(config.fetcher ? { fetcher: config.fetcher } : {}),
  };
  validateConfig(resolved);
  return resolved;
}

function validateConfig(config: ResolvedGammaConfig): void {
  if (config.apiKey.length === 0) {
    throw new Error("Gamma apiKey is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    throw new Error("Gamma baseUrl must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Gamma baseUrl must use HTTPS");
  }
}

// Gamma uses X-API-KEY header — not Authorization: Bearer
function gammaHeaders(apiKey: string): Record<string, string> {
  return {
    "X-API-KEY": apiKey,
    "Content-Type": "application/json",
  };
}

export function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

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

export async function gammaFetchJSON(
  config: ResolvedGammaConfig,
  request: GammaRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = new URL(`${normalizeBaseUrl(config.baseUrl)}${request.path}`);
  if (request.query !== undefined) {
    for (const [key, value] of Object.entries(request.query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), {
    method: request.method,
    headers: gammaHeaders(config.apiKey),
    ...(signal !== undefined ? { signal } : {}),
    ...(request.body !== undefined
      ? { body: JSON.stringify(request.body) }
      : {}),
  } satisfies RequestInit);

  if (!response.ok) {
    const body = errorMessageFromBody(await response.text().catch(() => ""));
    const detail = body || response.statusText;
    throw new Error(
      `Gamma API error: ${response.status}${detail ? ` ${detail}` : ""}`,
    );
  }

  return (await response.json()) as unknown;
}

const ERROR_BODY_MAX_LENGTH = 500;

export function errorMessageFromBody(text: string): string | null {
  if (text.length === 0) {
    return null;
  }
  const truncated =
    text.length > ERROR_BODY_MAX_LENGTH
      ? text.slice(0, ERROR_BODY_MAX_LENGTH) + "…"
      : text;
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
    return truncated;
  }
  return truncated;
}

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 100; // ~5 minutes

export async function pollGeneration(
  config: ResolvedGammaConfig,
  generationId: string,
  signal: AbortSignal,
): Promise<GenerationResult> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) {
      throw new Error("Generation polling aborted");
    }

    const result = await gammaFetchJSON(
      config,
      { method: "GET", path: `/generations/${generationId}` },
      signal,
    );

    if (!isRecord(result)) {
      throw new Error(`Unexpected generation status response`);
    }

    const status = result["status"];

    const statusResult = GenerationStatusSchema(status);
    if (statusResult instanceof type.errors) {
      throw new Error(`Unknown generation status: ${String(status)}`);
    }

    if (status === "completed") {
      const parsed = GenerationResultSchema(normalizeDeckUrlKey(result));
      if (parsed instanceof type.errors) {
        throw new Error(
          "Generation completed but gammaUrl or gammaId is missing",
        );
      }
      return parsed;
    }

    if (status === "failed") {
      throw new Error("Gamma generation failed");
    }

    await sleep(POLL_INTERVAL_MS, signal);
  }

  throw new Error("Gamma generation timed out");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function requiredString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}
