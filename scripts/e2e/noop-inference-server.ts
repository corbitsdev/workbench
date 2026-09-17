// A standalone stand-in for a real Anthropic endpoint: an e2e suite that
// wants a deployment costing zero real inference starts this tiny server
// itself (`startNoopInferenceServer`) and plants a catalog offering
// pointed at its own `baseUrl` (`ensureNoopCatalogOffering`), never at
// the hub.
//
// The wire shape matches exactly what
// `@intx/inference/src/providers/anthropic.ts`'s `parseResponse` accepts
// (see that file's `AnthropicSSEEvent` union, ~line 490-560):
// `message_start` (with zeroed usage), one `content_block_start` at
// index 0, one `content_block_delta` carrying a `text_delta`,
// `content_block_stop`, `message_delta` (with a nonzero `output_tokens`
// so downstream usage accounting sees a real number), then
// `message_stop`. `@intx/inference`'s `parseSSE` needs no `[DONE]`
// sentinel — the stream simply ends.
//
// The delta's text is deliberately empty, not merely short: an empty
// reply is exactly the posture a real model obeying "never reply" would
// earn by producing no text, so nothing downstream mistakes the
// constant for a real answer.

import type { ApiCall } from "../../packages/hub-api-client/src/index.ts";
import {
  ensureCatalogModel,
  ensureCatalogOffering,
  ensureCatalogProvider,
  ensureCredential,
  ensureProvider,
  inferenceCredentialName,
  PLACEHOLDER_CATALOG_API_KEY,
} from "../../packages/connections/src/seed-catalog.ts";

const NOOP_REPLY_TEXT = "";

function sseLine(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function noopInferenceResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const events: Record<string, unknown>[] = [
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: NOOP_REPLY_TEXT },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      for (const event of events) {
        controller.enqueue(encoder.encode(sseLine(event)));
      }
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

export type NoopInferenceServer = {
  readonly baseUrl: string;
  stop(): void;
};

/**
 * Starts a standalone HTTP server answering `POST /v1/messages` with the
 * constant noop SSE stream above, on an OS-assigned free port. No auth
 * check is needed here specifically because the handler takes no
 * action, reads no state, and returns a constant: there is nothing an
 * attacker could use this endpoint to do, see, or change regardless of
 * what credential (if any) they present. Callers must `stop()` it in
 * their own test cleanup — nothing here tracks it for them.
 */
export function startNoopInferenceServer(): NoopInferenceServer {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return noopInferenceResponse();
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

const NOOP_PROVIDER = "anthropic";
const NOOP_MODEL = "noop";
// The catalog provider/credential name a noop-pinned deployment's own
// offering is planted under — distinct from any real curated provider
// name (`CATALOG_SEEDS`'s keys), so this never collides with a tenant's
// real catalog and is trivially recognizable in the hub's own catalog UI.
const NOOP_CATALOG_PROVIDER_NAME = "noop";
// Priority is meaningless for this offering — it is never included in a
// real workflow's `sourceOfferingIds` (this offering's id is threaded
// through explicitly, never discovered by sorting), so any fixed value
// is honest here.
const NOOP_OFFERING_PRIORITY = 0;

/**
 * Plants (or finds) the dedicated catalog offering an e2e suite deploys
 * a zero-cost workflow against: a catalog model named `NOOP_MODEL`, a
 * provider pointed at this file's own `startNoopInferenceServer`
 * `baseUrl` (never the hub — dropped the hub's own mount), and a
 * placeholder credential — the same `ensureCatalogModel` / `ensureProvider`
 * / `ensureCredential` / `ensureCatalogProvider` / `ensureCatalogOffering`
 * sequence `seedCatalog` runs for a real provider, run here for this one
 * synthetic one. Idempotent, same as every other seed step: a re-run
 * finds the existing rows by name and reuses them.
 */
export async function ensureNoopCatalogOffering(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  noopServerBaseUrl: string,
  log: (line: string) => void,
): Promise<string> {
  // Matches the hub-mounted route's old convention: `baseURL` is the
  // endpoint's base, and the inference client itself appends
  // `/v1/messages` (`buildRequest` posts to `{baseURL}/v1/messages`).
  const baseURL = noopServerBaseUrl;
  const modelId = await ensureCatalogModel(
    api,
    cookies,
    { tenantId, canonicalName: NOOP_MODEL },
    log,
  );
  const providerId = await ensureProvider(
    api,
    cookies,
    {
      tenantId,
      name: NOOP_CATALOG_PROVIDER_NAME,
      plugin: NOOP_PROVIDER,
      apiBaseUrl: baseURL,
    },
    log,
  );
  const credentialId = await ensureCredential(
    api,
    cookies,
    {
      tenantId,
      providerId,
      name: inferenceCredentialName(NOOP_CATALOG_PROVIDER_NAME),
      secret: PLACEHOLDER_CATALOG_API_KEY,
      type: "api_key",
    },
    log,
  );
  const catalogProviderId = await ensureCatalogProvider(
    api,
    cookies,
    {
      tenantId,
      name: NOOP_CATALOG_PROVIDER_NAME,
      plugin: NOOP_PROVIDER,
      baseURL,
      credentialId,
    },
    log,
  );
  return ensureCatalogOffering(
    api,
    cookies,
    {
      tenantId,
      modelId,
      providerId: catalogProviderId,
      priority: NOOP_OFFERING_PRIORITY,
      capabilities: [],
    },
    log,
  );
}
