// The Routines page's seam to `@corbits/webhook-triggers`' HTTP routes
// (see packages/webhook-triggers/src/management-routes.ts), mirroring
// `routines-api.ts`: tenant-scoped request functions, each response
// validated at the boundary with an arktype schema owned here.
//
// A webhook trigger's secret is never stored client-side beyond the
// component state that shows it — the hub returns it exactly once, on
// create or rotate, and every other response (list/get) omits it
// entirely. Reloading the page or navigating away is enough to lose it
// again; that is the point, not a bug — see the rotate flow in
// `pages/routines-page.tsx`.
import { type } from "arktype";
import type { ArkErrors } from "arktype";

import { ApiQueryError } from "@corbits/api-query";

export const WebhookTrigger = type({
  id: "string",
  tenantId: "string",
  name: "string",
  workflowDefinitionId: "string",
  inputTemplate: "string",
  enabled: "boolean",
  createdBy: "string",
  createdAt: "string",
  lastFiredAt: "string | null",
});
export type WebhookTrigger = typeof WebhookTrigger.infer;

const WebhookTriggerWithSecret = WebhookTrigger.and({ secret: "string" });
export type WebhookTriggerWithSecret = typeof WebhookTriggerWithSecret.infer;

export type CreateWebhookTriggerInput = {
  readonly name: string;
  readonly workflowDefinitionId: string;
  readonly inputTemplate: string;
};

type Validator<T> = (data: unknown) => T | ArkErrors;

async function request<T>(
  path: string,
  schema: Validator<T>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new ApiQueryError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401) {
    throw new ApiQueryError(`Not signed in for ${path}.`, 401);
  }
  if (!response.ok) {
    const detail = await response
      .json()
      .then(
        (body: { error?: { message?: string } }) => body.error?.message ?? "",
      )
      .catch(() => "");
    throw new ApiQueryError(
      `The server answered ${response.status} for ${path}.${detail === "" ? "" : ` ${detail}`}`,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

export function listWebhookTriggers(
  tenantId: string,
): Promise<readonly WebhookTrigger[]> {
  return request(
    `/api/tenants/${tenantId}/webhook-triggers`,
    type({ items: WebhookTrigger.array() }),
  ).then((page) => page.items);
}

export function getWebhookTrigger(
  tenantId: string,
  id: string,
): Promise<WebhookTrigger> {
  return request(
    `/api/tenants/${tenantId}/webhook-triggers/${id}`,
    WebhookTrigger,
  );
}

/**
 * Default input mapping for a routine's webhook binding: a routine's
 * webhook trigger currently sends a fixed message rather than an
 * editable `{{path.to.field}}` template — see
 * `packages/webhook-triggers/src/mapping.ts`. Any well-formed JSON
 * payload with a valid signature starts the routine; templated field
 * mapping is a follow-on, not something this create flow exposes yet.
 */
export const DEFAULT_WEBHOOK_INPUT_TEMPLATE = "New webhook delivery.";

export function createWebhookTrigger(
  tenantId: string,
  input: CreateWebhookTriggerInput,
): Promise<WebhookTriggerWithSecret> {
  return request(
    `/api/tenants/${tenantId}/webhook-triggers`,
    WebhookTriggerWithSecret,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function rotateWebhookTriggerSecret(
  tenantId: string,
  id: string,
): Promise<WebhookTriggerWithSecret> {
  return request(
    `/api/tenants/${tenantId}/webhook-triggers/${id}/rotate-secret`,
    WebhookTriggerWithSecret,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function setWebhookTriggerEnabled(
  tenantId: string,
  id: string,
  enabled: boolean,
): Promise<WebhookTrigger> {
  return request(
    `/api/tenants/${tenantId}/webhook-triggers/${id}/enabled`,
    WebhookTrigger,
    { method: "POST", body: JSON.stringify({ enabled }) },
  );
}

export function deleteWebhookTrigger(
  tenantId: string,
  id: string,
): Promise<void> {
  return request(
    `/api/tenants/${tenantId}/webhook-triggers/${id}`,
    type("unknown"),
    { method: "DELETE" },
  ).then(() => undefined);
}

/** The URL a sender posts deliveries to — built client-side (no route
 * returns it) since it is a pure function of the trigger id and origin:
 * `POST /api/webhooks/:triggerId`, mounted outside tenant auth (see
 * `packages/webhook-triggers/src/ingress-routes.ts`). */
export function webhookTriggerUrl(triggerId: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/api/webhooks/${triggerId}`;
}

/**
 * A representative example of a POST body this trigger accepts —
 * documentation, not a schema: `@corbits/webhook-triggers` places no
 * constraint on payload shape beyond "valid JSON" (see
 * `ingress-routes.ts`), so this is illustrative only, never validated
 * against a real delivery.
 */
export function sampleWebhookPayload(): string {
  return JSON.stringify(
    {
      event: "example.event",
      data: { id: "123", summary: "Example payload" },
    },
    null,
    2,
  );
}
