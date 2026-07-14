import {
  DEFAULT_BASE_URL,
  isRecord,
  type LinearToolsConfig,
  validateConfig,
} from "./shared";

function linearHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: apiKey,
    "Content-Type": "application/json",
  };
}

function errorMessageFromBody(text: string): string | null {
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    return text;
  }
  return text;
}

export function graphqlErrorMessage(errors: unknown): string {
  if (!Array.isArray(errors)) {
    return "unknown error";
  }
  const messages = errors
    .map((entry) =>
      isRecord(entry) && typeof entry.message === "string" ? entry.message : null,
    )
    .filter((message): message is string => message !== null);
  return messages.length > 0 ? messages.join("; ") : "unknown error";
}

export async function fetchLinearGraphQL(
  config: LinearToolsConfig,
  query: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  validateConfig(config);
  const fetcher = config.fetcher ?? fetch;
  const endpoint =
    config.baseUrl !== undefined ? config.baseUrl : DEFAULT_BASE_URL;
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: linearHeaders(config.apiKey),
    body: JSON.stringify({ query, variables }),
    signal,
  } satisfies RequestInit);

  if (!response.ok) {
    const bodyText = errorMessageFromBody(
      await response.text().catch(() => ""),
    );
    // Prefer a non-empty body (gateways often leave statusText empty/generic).
    const detail = bodyText || response.statusText;
    throw new Error(`Linear API error: ${response.status} ${detail ?? ""}`);
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new Error("Linear response is not a valid object");
  }
  if (payload.errors !== undefined) {
    throw new Error(`Linear GraphQL error: ${graphqlErrorMessage(payload.errors)}`);
  }
  if (!isRecord(payload.data)) {
    throw new Error("Linear response is missing data");
  }
  return payload.data;
}
