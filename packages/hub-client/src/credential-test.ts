// A real test call for a credential a person is about to hand the
// onboarding flow, made before it's ever stored: the request is built
// by `@intx/inference`'s own Anthropic adapter — the same code path a
// deployed workflow's inference call goes through — so the wire format
// under test is Interchange's, never workbench's guess at it. Only the
// transport (one `fetch`, no streaming consumed) and the pass/fail
// verdict belong to workbench.

import { createAnthropicAdapter } from "@intx/inference/providers";
import { CREDENTIAL_SENTINEL } from "@intx/inference";
import { catalogModel, catalogProvider } from "./catalog-seed-data";

export type CredentialTestResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Headers; body: string },
) => Promise<Response>;

export type TestAnthropicCredentialArgs = {
  readonly apiKey: string;
  readonly fetchImpl?: FetchLike;
};

function anthropicErrorMessage(status: number, body: string): string {
  const parsed: unknown = JSON.parse(body);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "error" in parsed &&
    typeof (parsed as { error: unknown }).error === "object" &&
    (parsed as { error: unknown }).error !== null &&
    "message" in (parsed as { error: { message: unknown } }).error &&
    typeof (parsed as { error: { message: unknown } }).error.message ===
      "string"
  ) {
    return (parsed as { error: { message: string } }).error.message;
  }
  return `Anthropic rejected the request with status ${status}`;
}

/**
 * Fires the smallest real Anthropic call a credential can be validated
 * with — a one-token completion against the same model the onboarding
 * catalog seeds — and reports whether the key works. Never stores or
 * logs the key; the caller owns that decision once this says `ok`.
 */
export async function testAnthropicCredential(
  args: TestAnthropicCredentialArgs,
): Promise<CredentialTestResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const adapter = createAnthropicAdapter({
    sourceId: "onboarding-credential-test",
    provider: catalogProvider.name,
    model: catalogModel.canonicalName,
  });

  const request = adapter.buildRequest(
    [
      {
        role: "user",
        content: [{ type: "text", text: "Reply with the word ok." }],
        timestamp: Date.now(),
      },
    ],
    catalogModel.canonicalName,
    { maxTokens: 1 },
  );

  if (request.headers["x-api-key"] !== CREDENTIAL_SENTINEL) {
    return {
      ok: false,
      message:
        "internal error: the Anthropic adapter no longer uses the credential sentinel this test relies on",
    };
  }
  const headers = new Headers(request.headers);
  headers.set("x-api-key", args.apiKey);

  let response: Response;
  try {
    response = await doFetch(`${catalogProvider.baseURL}${request.url}`, {
      method: "POST",
      headers,
      body: request.body,
    });
  } catch (cause) {
    return {
      ok: false,
      message:
        cause instanceof Error
          ? `Could not reach Anthropic: ${cause.message}`
          : `Could not reach Anthropic: ${String(cause)}`,
    };
  }

  const body = await response.text();

  if (response.ok) return { ok: true };
  return { ok: false, message: anthropicErrorMessage(response.status, body) };
}
