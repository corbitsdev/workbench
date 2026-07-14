import { type } from "arktype";

export type LinearFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export const LinearToolsConfigSchema = type({
  apiKey: "string",
  "baseUrl?": "string",
});

export type LinearToolsConfig = typeof LinearToolsConfigSchema.infer & {
  fetcher?: LinearFetch;
};

export const DEFAULT_BASE_URL = "https://api.linear.app/graphql";

export const DEFAULT_ISSUE_LIMIT = 10;
export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT_ISSUES = 250;

export const BRIEF_SOURCE_SKIPPED_MARKER = { skipped: true as const };

export function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function optionalPositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

export function optionalPriority(value: unknown): number | null {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 4
  ) {
    return null;
  }
  return value;
}

export function validateConfig(config: LinearToolsConfig): void {
  if (config.apiKey.length === 0) {
    throw new Error("Linear apiKey is required");
  }
  if (config.baseUrl !== undefined) {
    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error("Linear baseUrl must be a valid URL");
    }
  }
}

export function resolveHubCredentialConfig(config: {
  apiKey: string;
  baseURL: string;
}): LinearToolsConfig {
  return config.baseURL.length > 0
    ? { apiKey: config.apiKey, baseUrl: config.baseURL }
    : { apiKey: config.apiKey };
}

export function isBriefSourceFetchEnabled(
  sourceKey: string,
  enabledSources: string[] | undefined,
): boolean {
  return enabledSources === undefined || enabledSources.includes(sourceKey);
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

export function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function requireString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = optionalString(args[key]);
  if (value === null) {
    throw new Error(`${key} is required`);
  }
  return value;
}

export function requireNonEmptyString(value: unknown, label: string): string {
  const parsed = optionalString(value);
  if (parsed === null) {
    throw new Error(`${label} is required`);
  }
  return parsed;
}

export function extractMutationIssue(
  data: Record<string, unknown>,
  mutationKey: string,
): Record<string, unknown> {
  const mutation = data[mutationKey];
  if (!isRecord(mutation) || !isRecord(mutation.issue)) {
    throw new Error(`Linear did not return the issue from ${mutationKey}`);
  }
  return mutation.issue;
}

/** Require a GraphQL mutation payload with success: true; return the mutation record. */
export function requireMutationSuccess(
  data: Record<string, unknown>,
  mutationKey: string,
): Record<string, unknown> {
  const mutation = data[mutationKey];
  if (!isRecord(mutation) || mutation.success !== true) {
    throw new Error(`Linear ${mutationKey} failed`);
  }
  return mutation;
}