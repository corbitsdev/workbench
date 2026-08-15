// Real, free credential probes for the tool connectors this ticket
// adds — Granola, Exa, ScrapeCreators, Linear, and GitHub — each hitting the
// same production endpoint its tool client (`packages/*-tools/src/
// client.ts`) already calls, authenticated with the real key. This
// mirrors `@workbench/hub-client/credential-test`'s
// `testProviderCredential` pattern exactly: a 5s timeout, a network
// failure caught as a plain rejection, `response.ok` (or a
// provider-specific override) as acceptance, and a 401 as the standard
// "key rejected" signal. No credential is ever stored here.
import type {
  CredentialTestResult,
  FetchLike,
} from "@workbench/hub-client/credential-test";

const PROBE_TIMEOUT_MS = 5000;

async function probe(
  displayName: string,
  fetchImpl: FetchLike,
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
  },
): Promise<CredentialTestResult> {
  let response: Response;
  try {
    const fetchArgs: Parameters<FetchLike>[1] = {
      method: init.method,
      headers: new Headers(init.headers),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    };
    if (init.body !== undefined) fetchArgs.body = init.body;
    response = await fetchImpl(url, fetchArgs);
  } catch (cause) {
    return {
      ok: false,
      message:
        cause instanceof Error
          ? `Could not reach ${displayName}: ${cause.message}`
          : `Could not reach ${displayName}: ${String(cause)}`,
    };
  }

  if (response.ok) return { ok: true };

  if (response.status === 401) {
    return {
      ok: false,
      message: `${displayName} rejected the key with status 401`,
    };
  }

  return {
    ok: false,
    message: `${displayName} returned an unexpected error (not a rejected key): status ${response.status}`,
  };
}

export function testGranolaCredential(
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<CredentialTestResult> {
  return probe("Granola", fetchImpl, "https://api.granola.ai/v1/notes", {
    method: "GET",
    headers: { authorization: `Bearer ${apiKey}` },
  });
}

export function testExaCredential(
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<CredentialTestResult> {
  return probe("Exa", fetchImpl, "https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ query: "test", numResults: 1 }),
  });
}

export function testScrapeCreatorsCredential(
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<CredentialTestResult> {
  return probe(
    "ScrapeCreators",
    fetchImpl,
    "https://api.scrapecreators.com/v1/reddit/search?query=test",
    {
      method: "GET",
      headers: { "x-api-key": apiKey },
    },
  );
}

export function testGitHubCredential(
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<CredentialTestResult> {
  return probe("GitHub", fetchImpl, "https://api.github.com/user", {
    method: "GET",
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/vnd.github+json",
    },
  });
}

export function testLinearCredential(
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<CredentialTestResult> {
  return probe("Linear", fetchImpl, "https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/json" },
    body: JSON.stringify({ query: "{ viewer { id } } " }),
  });
}
